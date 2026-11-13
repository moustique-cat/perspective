// SVG path data to geometry, in double precision.
//
// The renderer draws the very marks the SVG draws: it reads each element's path data out of
// the page and works from that. This file parses the path grammar the design uses, keeps
// arcs as true ellipse arcs (the browser draws them exactly too, as rational curves), and
// turns curves into runs of straight segments fine enough for a given scale.

/** An affine transform [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
export type Matrix = [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** Parses an SVG transform list: translate, scale and rotate, as the design uses them. */
export function parseTransform(text: string | null | undefined): Matrix {
  let m: Matrix = IDENTITY;
  if (!text) return m;
  const re = /\s*(\w+)\s*\(([^)]*)\)\s*/y;
  let at = 0;
  while (at < text.length) {
    re.lastIndex = at;
    const hit = re.exec(text);
    if (!hit) throw new Error('transform not understood: ' + text);
    at = re.lastIndex;
    const v = hit[2].trim().split(/[\s,]+/).map(Number);
    if (v.some((n) => !Number.isFinite(n))) throw new Error('transform not understood: ' + text);
    let n: Matrix;
    if (hit[1] === 'translate' && (v.length === 1 || v.length === 2)) n = [1, 0, 0, 1, v[0], v[1] || 0];
    else if (hit[1] === 'scale' && (v.length === 1 || v.length === 2)) n = [v[0], 0, 0, v.length === 2 ? v[1] : v[0], 0, 0];
    else if (hit[1] === 'rotate' && v.length === 1) { const a = v[0] * Math.PI / 180; n = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]; }
    else throw new Error('transform not understood: ' + text);
    m = multiply(m, n);
  }
  return m;
}

/** The largest factor by which the transform stretches a length. */
export function maxScale(m: Matrix): number {
  const p = m[0] * m[0] + m[1] * m[1] + m[2] * m[2] + m[3] * m[3];
  const q = m[0] * m[3] - m[1] * m[2];
  return Math.sqrt((p + Math.sqrt(Math.max(0, p * p - 4 * q * q))) / 2);
}

export const LINE = 0, QUAD = 1, CUBIC = 2, ARC = 3;
/**
 * One piece of a subpath, ending at (x, y). Curves carry their control points; an arc
 * carries its ellipse: centre, radii, the cosine and sine of its rotation, start angle and
 * signed sweep.
 */
export type Piece =
  | { t: 0; x: number; y: number }
  | { t: 1; x1: number; y1: number; x: number; y: number }
  | { t: 2; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { t: 3; cx: number; cy: number; rx: number; ry: number; cos: number; sin: number; a0: number; da: number; x: number; y: number };

export interface Subpath {
  x: number;
  y: number;
  pieces: Piece[];
  closed: boolean;
}

const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, Q: 4, A: 7, Z: 0, h: 1 };

/**
 * Parses path data. Strict on purpose: it accepts the commands the design uses (absolute
 * M L H V C Q A Z, and the relative "h0" of its dots), each written out with its own letter,
 * and throws on anything else, so that a change in the design cannot be drawn wrongly in
 * silence.
 */
export function parsePath(d: string): Subpath[] {
  const out: Subpath[] = [];
  const re = /\s*(?:([A-Za-z])|(-?(?:\d+\.?\d*|\.\d+)))/y;
  let at = 0, cmd = '', need = 0, sub: Subpath | null = null, x = 0, y = 0;
  const args: number[] = [];
  const run = (): void => {
    if (cmd === 'M') {
      sub = { x: args[0], y: args[1], pieces: [], closed: false };
      out.push(sub);
      x = args[0]; y = args[1];
      return;
    }
    if (!sub || sub.closed) throw new Error('path data: "' + cmd + '" with no subpath open');
    if (cmd === 'Z') { sub.closed = true; x = sub.x; y = sub.y; return; }
    if (cmd === 'L') { x = args[0]; y = args[1]; sub.pieces.push({ t: LINE, x, y }); }
    else if (cmd === 'H') { x = args[0]; sub.pieces.push({ t: LINE, x, y }); }
    else if (cmd === 'V') { y = args[0]; sub.pieces.push({ t: LINE, x, y }); }
    else if (cmd === 'h') { x += args[0]; sub.pieces.push({ t: LINE, x, y }); }
    else if (cmd === 'Q') { sub.pieces.push({ t: QUAD, x1: args[0], y1: args[1], x: args[2], y: args[3] }); x = args[2]; y = args[3]; }
    else if (cmd === 'C') { sub.pieces.push({ t: CUBIC, x1: args[0], y1: args[1], x2: args[2], y2: args[3], x: args[4], y: args[5] }); x = args[4]; y = args[5]; }
    else { sub.pieces.push(arc(x, y, args[0], args[1], args[2], args[3] !== 0, args[4] !== 0, args[5], args[6])); x = args[5]; y = args[6]; }
  };
  while (at < d.length) {
    re.lastIndex = at;
    const hit = re.exec(d);
    if (!hit) {
      if (d.slice(at).trim() === '') break;
      throw new Error('path data not understood at ' + at + ': ' + d.slice(at, at + 24));
    }
    at = re.lastIndex;
    if (hit[1]) {
      if (need) throw new Error('path data: "' + cmd + '" is short of numbers');
      cmd = hit[1];
      if (!(cmd in ARGS)) throw new Error('path data: command "' + cmd + '" is not one the design uses');
      need = ARGS[cmd];
      args.length = 0;
      if (!need) run();
    } else {
      if (!need) throw new Error('path data: a number where a command letter was expected, at ' + at);
      args.push(Number(hit[2]));
      if (--need === 0) run();
    }
  }
  if (need) throw new Error('path data: "' + cmd + '" is short of numbers');
  return out;
}

/** An SVG arc from (x0, y0) to (x, y), from its endpoint form to its ellipse (SVG 2, B.2.4). */
function arc(x0: number, y0: number, rx: number, ry: number, deg: number, large: boolean, sweep: boolean, x: number, y: number): Piece {
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (rx === 0 || ry === 0 || (x0 === x && y0 === y)) return { t: LINE, x, y };
  const phi = deg * Math.PI / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x0 - x) / 2, dy = (y0 - y) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = k * rx * y1 / ry, cyp = -k * ry * x1 / rx;
  const cx = cos * cxp - sin * cyp + (x0 + x) / 2, cy = sin * cxp + cos * cyp + (y0 + y) / 2;
  const a0 = Math.atan2((y1 - cyp) / ry, (x1 - cxp) / rx);
  let da = Math.atan2((-y1 - cyp) / ry, (-x1 - cxp) / rx) - a0;
  if (sweep && da < 0) da += 2 * Math.PI;
  else if (!sweep && da > 0) da -= 2 * Math.PI;
  return { t: ARC, cx, cy, rx, ry, cos, sin, a0, da, x, y };
}

/**
 * The points of a subpath after a transform, as [x0, y0, x1, y1, ...], with curves broken
 * into straight segments that stay within `tolerance` of the true curve (in the units the
 * transform maps to). Repeated points are dropped, so a subpath that never moves comes back
 * as one point: a dot.
 */
export function flatten(sub: Subpath, m: Matrix, tolerance: number, out: number[] = []): number[] {
  out.length = 0;
  const tx = (x: number, y: number) => m[0] * x + m[2] * y + m[4];
  const ty = (x: number, y: number) => m[1] * x + m[3] * y + m[5];
  let px = tx(sub.x, sub.y), py = ty(sub.x, sub.y);
  out.push(px, py);
  const add = (x: number, y: number): void => {
    if (x !== px || y !== py) { out.push(x, y); px = x; py = y; }
  };
  // a curve's last point is taken from its end, not computed, so pieces meet exactly
  let sx = sub.x, sy = sub.y;
  const stretch = maxScale(m);
  for (const p of sub.pieces) {
    if (p.t === QUAD) {
      const ax = tx(sx, sy), ay = ty(sx, sy), bx = tx(p.x1, p.y1), by = ty(p.x1, p.y1), cx = tx(p.x, p.y), cy = ty(p.x, p.y);
      const n = steps(Math.sqrt(Math.hypot(ax - 2 * bx + cx, ay - 2 * by + cy) / (4 * tolerance)));
      for (let i = 1; i < n; i++) {
        const t = i / n, u = 1 - t;
        add(u * u * ax + 2 * u * t * bx + t * t * cx, u * u * ay + 2 * u * t * by + t * t * cy);
      }
      add(cx, cy);
    } else if (p.t === CUBIC) {
      const ax = tx(sx, sy), ay = ty(sx, sy), bx = tx(p.x1, p.y1), by = ty(p.x1, p.y1);
      const cx = tx(p.x2, p.y2), cy = ty(p.x2, p.y2), dx = tx(p.x, p.y), dy = ty(p.x, p.y);
      // Wang's bound on the distance between a cubic and its polyline of n equal steps
      const bend = Math.max(Math.hypot(ax - 2 * bx + cx, ay - 2 * by + cy), Math.hypot(bx - 2 * cx + dx, by - 2 * cy + dy));
      const n = steps(Math.sqrt(0.75 * bend / tolerance));
      for (let i = 1; i < n; i++) {
        const t = i / n, u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t;
        add(a * ax + b * bx + c * cx + e * dx, a * ay + b * by + c * cy + e * dy);
      }
      add(dx, dy);
    } else if (p.t === ARC) {
      const r = Math.max(p.rx, p.ry) * stretch;
      const step = tolerance >= r ? Math.PI : 2 * Math.acos(1 - tolerance / r);
      const n = steps(Math.abs(p.da) / step);
      for (let i = 1; i < n; i++) {
        const a = p.a0 + p.da * i / n, ex = p.rx * Math.cos(a), ey = p.ry * Math.sin(a);
        const x = p.cx + p.cos * ex - p.sin * ey, y = p.cy + p.sin * ex + p.cos * ey;
        add(tx(x, y), ty(x, y));
      }
      add(tx(p.x, p.y), ty(p.x, p.y));
    } else {
      add(tx(p.x, p.y), ty(p.x, p.y));
    }
    sx = p.x; sy = p.y;
  }
  // a closed subpath comes back to its start: the closing segment is implied, not repeated
  if (sub.closed && out.length > 2 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) out.length -= 2;
  return out;
}

const MAX_STEPS = 4096;
function steps(n: number): number {
  return n > 1 ? Math.min(MAX_STEPS, Math.ceil(n)) : 1;
}

/** A circle as the browser builds one from a <circle> element: from 3 o'clock, clockwise on screen. */
export function circle(cx: number, cy: number, r: number): Subpath {
  const half = (a0: number, x: number): Piece => ({ t: ARC, cx, cy, rx: r, ry: r, cos: 1, sin: 0, a0, da: Math.PI, x, y: cy });
  return { x: cx + r, y: cy, pieces: [half(0, cx - r), half(Math.PI, cx + r)], closed: true };
}

/**
 * If the subpath is a full circle drawn as arcs of one circle, its centre and radius.
 * The design draws its small filled shapes (eyes, nose) this way.
 */
export function asCircle(sub: Subpath): { cx: number; cy: number; r: number } | null {
  if (!sub.closed || !sub.pieces.length) return null;
  let sweep = 0;
  const first = sub.pieces[0];
  if (first.t !== ARC) return null;
  for (const p of sub.pieces) {
    if (p.t !== ARC || Math.abs(p.rx - p.ry) > 1e-9 * p.rx) return null;
    if (Math.hypot(p.cx - first.cx, p.cy - first.cy) > 1e-6 * first.rx || Math.abs(p.rx - first.rx) > 1e-9 * first.rx) return null;
    sweep += p.da;
  }
  return Math.abs(Math.abs(sweep) - 2 * Math.PI) < 1e-6 ? { cx: first.cx, cy: first.cy, r: first.rx } : null;
}
