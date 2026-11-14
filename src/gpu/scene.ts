// The drawing as the chip wants it: one small record per mark.
//
// A layer of the design is a list of elements in paint order. For a given range of scales it
// is turned once into a "level": every stroke broken into straight segments just fine enough
// for that range, each segment one fixed-size record, plus triangles for the few filled
// shapes. Nothing in a level is touched again when the zoom changes; the chip places and
// strokes the records from one scale and one offset per layer.
//
// Because the view never pans, what can be on screen at a given scale is a disc around a
// fixed point of the layer. A level keeps only the marks inside the disc for its coarsest
// scale, sorted by distance from that point, so the marks on screen at any scale are a prefix
// of each batch: found by one binary search, drawn without looking at the rest.
import { asCircle, flatten, maxScale, type Matrix, type Subpath } from './path';

export const NONE = 0, WHITE = 1, INK = 2;

/** One drawn element of the design. */
export interface ElementSource {
  paths: Subpath[];
  /** From the element's own coordinates to its layer's. */
  matrix: Matrix;
  /** Stroke width in CSS px; 0 for no stroke. */
  width: number;
  /** Stroke opacity, times the opacity of a group that holds only this element. */
  opacity: number;
  /** Dash lengths on and off, in CSS px. */
  dash: [number, number] | null;
  fill: 0 | 1 | 2;
}

export interface LayerSource {
  name: string;
  elements: ElementSource[];
}

/** Opaque strokes, drawn straight onto the picture: where they overlap, ink over ink is ink. */
export const B_INK = 0;
/**
 * One translucent or dashed element. Its stroke is one shape: where it crosses itself it
 * must not get darker, so it is gathered first and laid down once.
 */
export const B_UNION = 1;
/** The inside of a filled shape, as triangles. */
export const B_FILL = 2;

export interface Batch {
  kind: number;
  /** First record (strokes) or first vertex (fills) and how many. */
  first: number;
  count: number;
  /** Strokes: each record's distance from the level's origin, ascending. */
  reach: Float32Array | null;
  opacity: number;
  dash: [number, number] | null;
  /** Fills: white, or ink. */
  white: boolean;
}

/** Bytes per record: two points, the points before and after, arc length, and four small numbers. */
export const RECORD_BYTES = 40;
/** Flags in a record. A capped end is a real, round end of a stroke; otherwise it meets a neighbour. */
export const F_CAP_A = 1, F_CAP_B = 2;
/** The record is a filled disc that scales with the drawing; its radius is in the arc length slot. */
export const F_DISC = 4;

export interface Level {
  /** The point of the layer that records are measured from. */
  origin: [number, number];
  /** Marks further than this from the origin were left out. */
  radius: number;
  /** Curves stay within this distance of the truth, in layer units. */
  tolerance: number;
  records: ArrayBuffer;
  count: number;
  /** Fill triangles: x, y per vertex, relative to the origin. */
  fills: Float32Array;
  /** In paint order. */
  batches: Batch[];
}

export interface LevelOptions {
  tolerance: number;
  origin: [number, number];
  /** Leave out marks further than this from the origin (layer units). */
  radius: number;
  /** The distinct stroke widths of the design, CSS px; a record names its width by index. */
  widths: number[];
}

/** A layer whose marks can fade as one shape without a separate picture: only opaque strokes, or one element. */
export function fadesInPlace(level: Level): boolean {
  return level.batches.length <= 1 && level.batches.every((b) => b.kind !== B_FILL);
}

interface Pending {
  // one record: p0, p1, previous point, next point, arc length (or radius), width index, flags, distance
  v: number[];
}

/** Distance from (cx, cy) to the segment (ax, ay)-(bx, by). */
function distanceTo(cx: number, cy: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((cx - ax) * dx + (cy - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ax + t * dx - cx, ay + t * dy - cy);
}

/** Adds the stroke of one flattened subpath to `out`. */
function strokeRecords(pts: number[], closed: boolean, widthIndex: number, opt: LevelOptions, out: Pending): void {
  const n = pts.length / 2, [ox, oy] = opt.origin, v = out.v;
  if (n === 1) {
    const x = pts[0] - ox, y = pts[1] - oy, far = Math.hypot(x, y);
    if (far <= opt.radius) v.push(x, y, x, y, x, y, x, y, 0, widthIndex, F_CAP_A | F_CAP_B, far);
    return;
  }
  const segments = closed ? n : n - 1;
  let s = 0;
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % n;
    const ax = pts[2 * i], ay = pts[2 * i + 1], bx = pts[2 * j], by = pts[2 * j + 1];
    const length = Math.hypot(bx - ax, by - ay);
    const far = distanceTo(ox, oy, ax, ay, bx, by);
    if (far <= opt.radius) {
      let flags = 0, px = ax, py = ay, nx = bx, ny = by;
      if (closed || i > 0) { const k = (i - 1 + n) % n; px = pts[2 * k]; py = pts[2 * k + 1]; } else flags |= F_CAP_A;
      if (closed || i < segments - 1) { const k = (j + 1) % n; nx = pts[2 * k]; ny = pts[2 * k + 1]; } else flags |= F_CAP_B;
      v.push(ax - ox, ay - oy, bx - ox, by - oy, px - ox, py - oy, nx - ox, ny - oy, s, widthIndex, flags, far);
    }
    s += length;
  }
}

const PER = 12;

/** Writes pending records into the level's buffer, nearest first, and returns their batch. */
function flush(pending: Pending, kind: number, el: { opacity: number; dash: [number, number] | null } | null, sink: { f: number[]; meta: number[] }, batches: Batch[]): void {
  const v = pending.v, n = v.length / PER;
  if (!n) return;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => v[a * PER + 11] - v[b * PER + 11]);
  const reach = new Float32Array(n), first = sink.meta.length / 2;
  for (let k = 0; k < n; k++) {
    const at = order[k] * PER;
    for (let c = 0; c < 9; c++) sink.f.push(v[at + c]);
    sink.meta.push(v[at + 9], v[at + 10]);
    reach[k] = v[at + 11];
  }
  batches.push({ kind, first, count: n, reach, opacity: el ? el.opacity : 1, dash: el ? el.dash : null, white: false });
  v.length = 0;
}

/** Builds one level of a layer. */
export function buildLevel(layer: LayerSource, opt: LevelOptions): Level {
  const batches: Batch[] = [];
  const sink = { f: [] as number[], meta: [] as number[] };
  const fills: number[] = [];
  const ink: Pending = { v: [] }, own: Pending = { v: [] };
  // strokes that have to be gathered on their own, held back until the opaque ink before the next fill is out
  let unions: { v: number[]; el: ElementSource }[] = [];
  const pts: number[] = [];
  const [ox, oy] = opt.origin;

  const run = (): void => {
    flush(ink, B_INK, null, sink, batches);
    for (const u of unions) flush({ v: u.v }, B_UNION, u.el, sink, batches);
    unions = [];
  };

  for (const el of layer.elements) {
    const widthIndex = el.width > 0 ? opt.widths.indexOf(el.width) : 0;
    if (widthIndex < 0) throw new Error(`stroke width ${el.width} is not in the width table`);
    if (el.fill !== NONE) {
      const discs = el.fill === INK && el.width === 0 ? el.paths.map(asCircle) : null;
      if (discs && discs.every((c) => c)) {
        // small filled circles (her eyes and nose): a disc mark each, which scales with the drawing
        const scale = maxScale(el.matrix);
        if (el.opacity < 0.9995) throw new Error('a translucent filled shape is not supported');
        for (const c of discs) {
          const x = el.matrix[0] * c!.cx + el.matrix[2] * c!.cy + el.matrix[4] - ox, y = el.matrix[1] * c!.cx + el.matrix[3] * c!.cy + el.matrix[5] - oy;
          const far = Math.max(0, Math.hypot(x, y) - c!.r * scale);
          if (far <= opt.radius) ink.v.push(x, y, x, y, x, y, x, y, c!.r * scale, 0, F_DISC | F_CAP_A | F_CAP_B, far);
        }
        continue;
      }
      if (el.fill !== WHITE || el.opacity < 0.9995 || el.dash) throw new Error('only white fills with a solid outline, and ink-filled circles, are supported');
      // everything painted so far must be down before the white covers it
      run();
      const first = fills.length / 2;
      for (const sub of el.paths) {
        flatten(sub, el.matrix, opt.tolerance, pts);
        triangulate(pts, ox, oy, fills);
      }
      if (fills.length / 2 > first) batches.push({ kind: B_FILL, first, count: fills.length / 2 - first, reach: null, opacity: 1, dash: null, white: true });
    }
    if (el.width > 0) {
      const gather = el.opacity < 0.9995 || !!el.dash;
      const into = gather ? own : ink;
      for (const sub of el.paths) {
        flatten(sub, el.matrix, opt.tolerance, pts);
        strokeRecords(pts, sub.closed && pts.length > 2, widthIndex, opt, into);
      }
      if (gather && own.v.length) { unions.push({ v: own.v, el }); own.v = []; }
    }
  }
  run();

  const count = sink.meta.length / 2;
  const records = new ArrayBuffer(count * RECORD_BYTES);
  const f32 = new Float32Array(records), u8 = new Uint8Array(records);
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 9; c++) f32[i * 10 + c] = sink.f[i * 9 + c];
    u8[i * RECORD_BYTES + 36] = sink.meta[2 * i];
    u8[i * RECORD_BYTES + 37] = sink.meta[2 * i + 1];
  }
  return { origin: [ox, oy], radius: opt.radius, tolerance: opt.tolerance, records, count, fills: new Float32Array(fills), batches };
}

/**
 * Cuts a simple polygon [x0, y0, x1, y1, ...] into triangles (ear clipping) and appends
 * them to `out`, relative to (ox, oy). The design's filled shapes are single closed outlines
 * that do not cross themselves.
 */
export function triangulate(pts: number[], ox: number, oy: number, out: number[]): void {
  const n = pts.length / 2;
  if (n < 3) return;
  let area = 0;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; area += pts[2 * i] * pts[2 * j + 1] - pts[2 * j] * pts[2 * i + 1]; }
  const sign = area < 0 ? -1 : 1;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(i);
  const cross = (a: number, b: number, c: number) => sign * ((pts[2 * b] - pts[2 * a]) * (pts[2 * c + 1] - pts[2 * a + 1]) - (pts[2 * b + 1] - pts[2 * a + 1]) * (pts[2 * c] - pts[2 * a]));
  const emit = (a: number, b: number, c: number) => out.push(pts[2 * a] - ox, pts[2 * a + 1] - oy, pts[2 * b] - ox, pts[2 * b + 1] - oy, pts[2 * c] - ox, pts[2 * c + 1] - oy);
  // a shape with no dents (every circle is one) is a fan
  let convex = true;
  for (let i = 0; i < n && convex; i++) convex = cross(i, (i + 1) % n, (i + 2) % n) >= 0;
  if (convex) {
    for (let i = 1; i < n - 1; i++) emit(0, i, i + 1);
    return;
  }
  let guard = 0;
  while (idx.length > 3 && guard++ < 4 * n * n) {
    let cut = -1, flattest = -1;
    for (let i = 0; i < idx.length && cut < 0; i++) {
      const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      const turn = cross(a, b, c);
      if (turn <= 0) { if (turn === 0) flattest = i; continue; }
      let empty = true;
      for (let k = 0; k < idx.length && empty; k++) {
        const p = idx[k];
        if (p === a || p === b || p === c) continue;
        // a point inside the corner, or on its edge, spoils the ear
        if (cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0) empty = false;
      }
      if (empty) cut = i;
    }
    if (cut < 0) {
      // no clean ear (points in a line, or an outline that touches itself): drop a flat or arbitrary corner and go on
      cut = flattest >= 0 ? flattest : 0;
    } else {
      emit(idx[(cut + idx.length - 1) % idx.length], idx[cut], idx[(cut + 1) % idx.length]);
    }
    idx.splice(cut, 1);
  }
  if (idx.length === 3 && cross(idx[0], idx[1], idx[2]) > 0) emit(idx[0], idx[1], idx[2]);
}

/** The box around a layer's marks, in layer units: [left, top, right, bottom]. */
export function boundsOf(layer: LayerSource): [number, number, number, number] {
  const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const pts: number[] = [];
  for (const el of layer.elements) {
    // coarse is enough: a curve's flattening stays inside the hull of its control points anyway
    const tol = 0.5;
    for (const sub of el.paths) {
      flatten(sub, el.matrix, tol, pts);
      for (let i = 0; i < pts.length; i += 2) {
        if (pts[i] < box[0]) box[0] = pts[i];
        if (pts[i + 1] < box[1]) box[1] = pts[i + 1];
        if (pts[i] > box[2]) box[2] = pts[i];
        if (pts[i + 1] > box[3]) box[3] = pts[i + 1];
      }
    }
  }
  if (box[0] > box[2]) return [0, 0, 0, 0];
  // room for what a coarse flattening can miss
  return [box[0] - 0.5, box[1] - 0.5, box[2] + 0.5, box[3] + 0.5];
}

/** How many of a batch's records lie within `limit` of the level's origin. */
export function within(batch: Batch, limit: number): number {
  const reach = batch.reach;
  if (!reach) return batch.count;
  let lo = 0, hi = reach.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (reach[mid] <= limit) lo = mid + 1; else hi = mid;
  }
  return lo;
}
