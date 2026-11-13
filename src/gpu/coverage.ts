// How much of a pixel a mark covers.
//
// The renderer does not multisample. Each pixel's share of ink is computed from geometry,
// as the area of the pixel square that the mark covers, which is what the browser's own
// rasteriser aims for when it draws the SVG. Two exact results carry it:
//
//   - a straight strip against a pixel: the strip's edge profile across a square pixel is a
//     trapezoid whose shape depends on the strip's angle (a box only when axis-aligned);
//   - a disc against a pixel: closed form, tabulated once per radius for the chip.
//
// The shaders implement the same formulas; tests/coverage.test.ts checks these against
// brute-force sampling.

/**
 * The share of a unit pixel lying on the near side of a straight edge, where `x` is the signed
 * distance from the pixel centre to the edge (positive: centre inside) and (m, q) are the
 * larger and smaller absolute components of the edge's unit normal.
 */
export function edge(x: number, m: number, q: number): number {
  const ax = Math.abs(x), top = (m - q) / 2, base = (m + q) / 2;
  let g: number;
  if (ax <= top) g = ax / m;
  else if (ax < base) g = 0.5 - (base - ax) * (base - ax) / (2 * m * q);
  else g = 0.5;
  return x < 0 ? 0.5 - g : 0.5 + g;
}

/** The share of a pixel covered by a strip of half-width h whose centre line passes at distance d. */
export function strip(d: number, h: number, m: number, q: number): number {
  return edge(d + h, m, q) - edge(d - h, m, q);
}

/** Area of a disc of radius r (centred on the origin) with X >= h. */
function cap(h: number, r: number): number {
  if (h >= r) return 0;
  if (h <= -r) return Math.PI * r * r;
  return r * r * Math.acos(h / r) - h * Math.sqrt(r * r - h * h);
}

/** Area of a disc of radius r (centred on the origin) with X >= x and Y >= y. */
function corner(x: number, y: number, r: number): number {
  if (x < 0) return cap(y, r) - corner(-x, y, r);
  if (y < 0) return cap(x, r) - corner(x, -y, r);
  if (x * x + y * y >= r * r) return 0;
  const xe = Math.sqrt(r * r - y * y);
  return 0.5 * r * r * (Math.asin(xe / r) - Math.asin(x / r)) - 0.5 * x * Math.sqrt(r * r - x * x) - 0.5 * xe * y + x * y;
}

/** The share of the unit pixel centred on the origin covered by a disc of radius r centred at (cx, cy). Exact. */
export function disc(cx: number, cy: number, r: number): number {
  const x0 = -0.5 - cx, x1 = 0.5 - cx, y0 = -0.5 - cy, y1 = 0.5 - cy;
  const area = corner(x0, y0, r) - corner(x1, y0, r) - corner(x0, y1, r) + corner(x1, y1, r);
  return area < 0 ? 0 : area > 1 ? 1 : area;
}

/** Area of a disc of radius r centred on the origin inside the rectangle [x0, x1] x [y0, y1]. Exact. */
export function discRect(x0: number, x1: number, y0: number, y1: number, r: number): number {
  if (x1 <= x0 || y1 <= y0) return 0;
  const area = corner(x0, y0, r) - corner(x1, y0, r) - corner(x0, y1, r) + corner(x1, y1, r);
  return area < 0 ? 0 : area;
}

/**
 * The round end of a stroke: the share of a pixel covered by the half of a disc of radius h
 * that lies beyond the end line, for a pixel centred `along` beyond that line and `across`
 * from the stroke's axis. The pixel is taken as square to the stroke, which a disc hardly
 * notices.
 */
export function roundEnd(along: number, across: number, h: number): number {
  return discRect(Math.max(along - 0.5, 0), along + 0.5, across - 0.5, across + 0.5, h);
}

/** The table the chip reads disc coverage from: LUT_W distances by LUT_H directions per radius. */
export const LUT_W = 64, LUT_H = 16;
/** A table spans distances from r - LUT_REACH to r + LUT_REACH from the disc's centre. */
export const LUT_REACH = 1;

/**
 * Disc coverage for one radius, by distance from the centre (columns) and direction (rows).
 * Direction is folded into the first half-quadrant and indexed by min/max of the offset's
 * absolute components, which the shader can compute without trigonometry.
 */
export function discTable(r: number, out: Uint8Array = new Uint8Array(LUT_W * LUT_H), offset = 0): Uint8Array {
  for (let j = 0; j < LUT_H; j++) {
    const fold = j / (LUT_H - 1), norm = Math.hypot(1, fold);
    for (let i = 0; i < LUT_W; i++) {
      const dist = Math.max(0, r - LUT_REACH + 2 * LUT_REACH * i / (LUT_W - 1));
      out[offset + j * LUT_W + i] = Math.round(255 * disc(dist / norm, dist * fold / norm, r));
    }
  }
  return out;
}

/** The table of round ends: END_N steps along the stroke by END_N across it, per half-width. */
export const END_N = 32;

/**
 * Round-end coverage for one half-width: columns run from half a pixel short of the end line
 * to h + 0.5 beyond it, rows from the stroke's axis to h + 0.5 beside it.
 */
export function endTable(h: number, out: Uint8Array = new Uint8Array(END_N * END_N), offset = 0): Uint8Array {
  for (let j = 0; j < END_N; j++) {
    for (let i = 0; i < END_N; i++) {
      out[offset + j * END_N + i] = Math.round(255 * roundEnd(-0.5 + (h + 1) * i / (END_N - 1), (h + 0.5) * j / (END_N - 1), h));
    }
  }
  return out;
}

/** Reads the table the way the shader does, with bilinear filtering. For tests. */
export function discFromTable(table: Uint8Array, dx: number, dy: number, r: number): number {
  const ax = Math.abs(dx), ay = Math.abs(dy), dist = Math.hypot(ax, ay);
  const mx = Math.max(ax, ay), fold = mx > 1e-5 ? Math.min(ax, ay) / mx : 0;
  const u = Math.min(1, Math.max(0, (dist - r + LUT_REACH) / (2 * LUT_REACH))) * (LUT_W - 1);
  const v = fold * (LUT_H - 1);
  const i = Math.min(LUT_W - 2, Math.floor(u)), j = Math.min(LUT_H - 2, Math.floor(v)), fu = u - i, fv = v - j;
  const at = (ii: number, jj: number) => table[jj * LUT_W + ii] / 255;
  return (at(i, j) * (1 - fu) + at(i + 1, j) * fu) * (1 - fv) + (at(i, j + 1) * (1 - fu) + at(i + 1, j + 1) * fu) * fv;
}

export const OPEN = 0, JOIN = 1, CAP = 2;

/** One straight segment of a stroke in pixel coordinates, as the fragment shader receives it. */
export interface Capsule {
  ax: number; ay: number; bx: number; by: number;
  /** Half the stroke width. */
  h: number;
  /** How each end finishes: OPEN (cut off screen), JOIN (meets a neighbour) or CAP (round end). */
  endA: number; endB: number;
  /** Unit direction of the neighbouring segment at a JOIN end: the one before A, the one after B. */
  pux?: number; puy?: number; nux?: number; nuy?: number;
  /** Dashes: lengths on and off, and the arc length at A. */
  on?: number; off?: number; sA?: number;
}

/** A corner sharper than this (the sine of its turn) is drawn as a corner; below it, as a bend. */
export const SHARP = 0.08;

const kernelOf = (ux: number, uy: number): [number, number] => {
  const a = Math.abs(ux), b = Math.abs(uy);
  return [Math.max(a, b), Math.max(Math.min(a, b), 1e-4)];
};

/**
 * The share of a pixel inside two half-planes at once, from its share a and b in each and
 * the cosine of the angle between their inward normals. Exact when they face the same way
 * (the smaller share), stand square to each other along the pixel grid (the product) or face
 * each other (what the two leave in common); between those, interpolated.
 */
export function both(a: number, b: number, cos: number): number {
  const product = a * b;
  return cos >= 0 ? product + (Math.min(a, b) - product) * cos : product + (Math.max(0, a + b - 1) - product) * -cos;
}

/**
 * The share of a pixel covered around a corner where a segment heading (u1x, u1y) ends at
 * (jx, jy) and one heading (u2x, u2y) begins: both strips and the round join between them.
 */
export function corner2(px: number, py: number, jx: number, jy: number, u1x: number, u1y: number, u2x: number, u2y: number, h: number, discOf: (dx: number, dy: number) => number): number {
  const x = px - jx, y = py - jy;
  const sin = u1x * u2y - u1y * u2x, cos = u1x * u2x + u1y * u2y;
  // positive towards the inside of the turn
  const side = sin >= 0 ? 1 : -1;
  const d1 = side * (-x * u1y + y * u1x), d2 = side * (-x * u2y + y * u2x);
  const [m1, q1] = kernelOf(u1x, u1y), [m2, q2] = kernelOf(u2x, u2y);
  // inside the outer edge of each strip; beyond the inner edge of each strip
  const outer = both(edge(d1 + h, m1, q1), edge(d2 + h, m2, q2), cos);
  const inner = both(edge(d1 - h, m1, q1), edge(d2 - h, m2, q2), cos);
  // past the end of the first and short of the start of the second: only the round join covers there
  const past = edge(x * u1x + y * u1y, m1, q1), short = 1 - edge(x * u2x + y * u2y, m2, q2);
  const gap = both(past, short, -cos);
  return Math.max(0, (1 - gap) * outer + gap * discOf(x, y) - inner);
}

/**
 * The share of the pixel centred at (px, py) that one segment of a stroke covers: the
 * reference for the marks shader, which computes the same thing.
 *
 * Along its body a segment is a strip. A real end adds the half disc beyond the end line
 * and takes away the strip's share there. Where two segments meet, each pixel belongs to
 * the segment on its side of the line bisecting the corner, so neighbours never both shade
 * a pixel; at a sharp corner the owner works out what both strips and the round join cover.
 */
export function capsule(px: number, py: number, c: Capsule, discOf: (dx: number, dy: number) => number = (dx, dy) => disc(dx, dy, c.h)): number {
  const abx = c.bx - c.ax, aby = c.by - c.ay, L = Math.hypot(abx, aby);
  const ux = L > 0 ? abx / L : 1, uy = L > 0 ? aby / L : 0;
  const pax = px - c.ax, pay = py - c.ay;
  if (L === 0 && c.endA === CAP && c.endB === CAP && !c.on) return discOf(pax, pay);
  let sinA = 0, sinB = 0;
  if (c.endA === JOIN) {
    const mx = c.pux! + ux, my = c.puy! + uy;
    if (pax * mx + pay * my < 0) return 0;
    sinA = Math.abs(c.pux! * uy - c.puy! * ux);
  }
  if (c.endB === JOIN) {
    const mx = ux + c.nux!, my = uy + c.nuy!;
    if ((px - c.bx) * mx + (py - c.by) * my >= 0) return 0;
    sinB = Math.abs(ux * c.nuy! - uy * c.nux!);
  }
  const t = pax * ux + pay * uy, d = -pax * uy + pay * ux;
  const [m, q] = kernelOf(ux, uy);
  const S = strip(d, c.h, m, q);
  let t0 = 0, t1 = L, roundA = c.endA === CAP, roundB = c.endB === CAP;
  if (c.on) {
    const period = c.on + c.off!, tc = Math.min(L, Math.max(0, t));
    let phase = (c.sA! + tc) % period;
    if (phase > c.on + 0.5 * c.off!) phase -= period;
    t0 = tc - phase; t1 = t0 + c.on;
    // a dash that runs past a joint carries on in the neighbour; past a real end it is cut there
    if (t0 < 0) { if (c.endA === CAP) t0 = 0; else roundA = false; } else roundA = true;
    if (t1 > L) { if (c.endB === CAP) t1 = L; else roundB = false; } else roundB = true;
    if (t1 < t0) return 0;
  }
  let cov = S;
  // a corner only reaches as far along the stroke as the neighbour's strip stays within a pixel of this one
  const near = 2 * c.h + 1.5;
  if (roundA) cov += roundEnd(t0 - t, d, c.h) - S * (1 - edge(t - t0, m, q));
  else if (!c.on && sinA > SHARP && t * sinA < near) cov += corner2(px, py, c.ax, c.ay, c.pux!, c.puy!, ux, uy, c.h, discOf) - S;
  if (roundB) cov += roundEnd(t - t1, d, c.h) - S * edge(t - t1, m, q);
  else if (!c.on && sinB > SHARP && (L - t) * sinB < near) cov += corner2(px, py, c.bx, c.by, ux, uy, c.nux!, c.nuy!, c.h, discOf) - S;
  return cov < 0 ? 0 : cov > 1 ? 1 : cov;
}
