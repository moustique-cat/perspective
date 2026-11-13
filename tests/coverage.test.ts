// The coverage formulas the shaders implement, against brute-force sampling of the shapes.
import { describe, expect, it } from 'vitest';
import { CAP, JOIN, OPEN, capsule, disc, discFromTable, discTable, edge, strip } from '../src/gpu/coverage';

/** Share of the unit pixel centred on (px, py) inside a shape, by sampling n x n points. */
function sampled(px: number, py: number, inside: (x: number, y: number) => boolean, n = 160): number {
  let hit = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (inside(px - 0.5 + (i + 0.5) / n, py - 0.5 + (j + 0.5) / n)) hit++;
  return hit / (n * n);
}
const kernel = (angle: number) => { const a = Math.abs(Math.cos(angle)), b = Math.abs(Math.sin(angle)); return [Math.max(a, b), Math.max(Math.min(a, b), 1e-4)] as const; };

describe('a straight edge against a pixel', () => {
  it('is the exact area at any angle and offset', () => {
    let worst = 0;
    for (let k = 0; k <= 24; k++) {
      const angle = k * Math.PI / 24, nx = Math.cos(angle), ny = Math.sin(angle), [m, q] = kernel(angle);
      for (let x = -0.9; x <= 0.9; x += 0.075) {
        // inside: the half-plane whose boundary passes at signed distance x from the pixel centre
        const exact = sampled(0, 0, (sx, sy) => sx * nx + sy * ny <= x, 240);
        worst = Math.max(worst, Math.abs(edge(x, m, q) - exact));
      }
    }
    expect(worst).toBeLessThan(0.004);
  });

  it('gives a 1.25 px line its full darkness only when it runs along the pixel grid', () => {
    expect(strip(0, 0.625, ...kernel(0))).toBeCloseTo(1, 6);
    expect(strip(0, 0.625, ...kernel(Math.PI / 4))).toBeCloseTo(0.987, 3);
  });

  it('puts exactly the line\'s width of ink across any line', () => {
    for (const h of [0.4, 0.425, 0.45, 0.625, 1.25, 1.875]) {
      for (const angle of [0, 0.2, 0.6, Math.PI / 4, 1.3]) {
        const [m, q] = kernel(angle);
        let sum = 0;
        for (let d = -6; d <= 6; d += 0.01) sum += strip(d, h, m, q) * 0.01;
        expect(sum).toBeCloseTo(2 * h, 3);
      }
    }
  });
});

describe('a disc against a pixel', () => {
  it('is the exact area for the design\'s dot sizes at 1x, 2x and 3x', () => {
    let worst = 0;
    for (const r of [0.4, 0.625, 0.7, 1, 1.4, 1.7, 2.75, 5.1, 8.25]) {
      for (let k = 0; k < 40; k++) {
        const cx = ((k * 0.377) % 1) * (r + 1), cy = ((k * 0.611) % 1) * (r + 1);
        const exact = sampled(0, 0, (x, y) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r, 200);
        worst = Math.max(worst, Math.abs(disc(cx, cy, r) - exact));
      }
    }
    expect(worst).toBeLessThan(0.004);
  });

  it('adds up to the disc\'s area over all pixels', () => {
    for (const r of [0.7, 1, 1.7, 2.75]) {
      for (const [ox, oy] of [[0, 0], [0.5, 0.5], [0.21, 0.83]]) {
        let sum = 0;
        for (let x = -8; x <= 8; x++) for (let y = -8; y <= 8; y++) sum += disc(ox - x, oy - y, r);
        expect(sum).toBeCloseTo(Math.PI * r * r, 9);
      }
    }
  });

  it('survives being tabulated for the chip', () => {
    let worst = 0, inkExact = 0, inkTable = 0;
    for (const r of [0.4, 0.625, 0.7, 1, 1.25, 1.7, 2.1, 2.75, 5.1, 8.25]) {
      const table = discTable(r);
      for (let k = 0; k < 400; k++) {
        const dx = ((k * 0.377) % 1) * (r + 1.2), dy = ((k * 0.611) % 1) * (r + 1.2);
        const exact = disc(dx, dy, r), got = discFromTable(table, dx, dy, r);
        worst = Math.max(worst, Math.abs(got - exact));
        inkExact += exact; inkTable += got;
      }
    }
    expect(worst).toBeLessThan(0.012);
    expect(Math.abs(inkTable / inkExact - 1)).toBeLessThan(0.002);
  });
});

describe('one segment of a stroke against a pixel', () => {
  const insideCapsule = (ax: number, ay: number, bx: number, by: number, h: number) => (x: number, y: number) => {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    return Math.hypot(x - ax - t * dx, y - ay - t * dy) <= h;
  };

  it('a zero-length segment is a dot', () => {
    for (const h of [0.7, 1, 1.7]) {
      const c = { ax: 0.3, ay: 0.2, bx: 0.3, by: 0.2, h, endA: CAP, endB: CAP };
      for (let x = -3; x <= 3; x++) for (let y = -3; y <= 3; y++) expect(capsule(x, y, c)).toBeCloseTo(disc(0.3 - x, 0.2 - y, h), 9);
    }
  });

  it('a capped segment carries the ink of its exact shape, pixel by pixel', () => {
    let worst = 0, total = 0, exactTotal = 0;
    for (const h of [0.425, 0.625, 1.25]) {
      for (const angle of [0, 0.35, Math.PI / 4, 1.1, Math.PI / 2, 2.4]) {
        for (const len of [0.6, 3.3, 9.7]) {
          const c = { ax: 0.37, ay: -0.21, bx: 0.37 + len * Math.cos(angle), by: -0.21 + len * Math.sin(angle), h, endA: CAP, endB: CAP };
          const inside = insideCapsule(c.ax, c.ay, c.bx, c.by, h);
          for (let x = -4; x <= 13; x++) for (let y = -4; y <= 13; y++) {
            const got = capsule(x, y, c), exact = sampled(x, y, inside, 40);
            worst = Math.max(worst, Math.abs(got - exact));
            total += got; exactTotal += exact;
          }
        }
      }
    }
    // the body is exact; an end treats the pixel as square to the stroke
    expect(worst).toBeLessThan(0.06);
    expect(Math.abs(total / exactTotal - 1)).toBeLessThan(0.01);
  });

  it('two segments meeting at a corner shade each pixel once, and add up to the bent stroke', () => {
    const worstBy: Record<string, number> = {};
    let total = 0, exactTotal = 0;
    for (const h of [0.425, 0.625, 1.25, 1.875]) {
      for (const turn of [0.02, 0.07, 0.2, 0.7, Math.PI / 2, -Math.PI / 2, 2.2, -2.2, 2.9]) {
        for (const heading of [0, 0.1, 0.9, 2.0, 3.6]) {
          const u1 = [Math.cos(heading), Math.sin(heading)], u2 = [Math.cos(heading + turn), Math.sin(heading + turn)];
          const bx = 0.3, by = 0.1, ax = bx - 30 * u1[0], ay = by - 30 * u1[1], cx = bx + 30 * u2[0], cy = by + 30 * u2[1];
          const first = { ax, ay, bx, by, h, endA: OPEN, endB: JOIN, nux: u2[0], nuy: u2[1] };
          const second = { ax: bx, ay: by, bx: cx, by: cy, h, endA: JOIN, endB: OPEN, pux: u1[0], puy: u1[1] };
          const in1 = insideCapsule(ax, ay, bx, by, h), in2 = insideCapsule(bx, by, cx, cy, h);
          for (let x = -5; x <= 5; x++) for (let y = -5; y <= 5; y++) {
            const a = capsule(x, y, first), b = capsule(x, y, second);
            expect(a === 0 || b === 0).toBe(true);
            const exact = sampled(x, y, (sx, sy) => in1(sx, sy) || in2(sx, sy), 40);
            const key = Math.abs(turn).toFixed(2);
            worstBy[key] = Math.max(worstBy[key] || 0, Math.abs(a + b - exact));
            total += a + b; exactTotal += exact;
          }
        }
      }
    }
    console.log(`  corners: worst pixel by turn (radians) ${JSON.stringify(worstBy)}; total ink ${(100 * (total / exactTotal - 1)).toFixed(2)} % off`);
    // a bend in a curve is exact to a hundredth; a right angle to 0.07; a hairpin to 0.1
    expect(worstBy['0.02']).toBeLessThan(0.012);
    expect(worstBy['0.07']).toBeLessThan(0.02);
    expect(worstBy['0.20']).toBeLessThan(0.04);
    expect(worstBy['1.57']).toBeLessThan(0.07);
    expect(Math.max(...Object.values(worstBy))).toBeLessThan(0.1);
    expect(Math.abs(total / exactTotal - 1)).toBeLessThan(0.005);
  });

  it('dashes: two on, five off, round ends, by arc length', () => {
    const c = { ax: 0, ay: 0.5, bx: 40, by: 0.5, h: 0.45, endA: CAP, endB: CAP, on: 2, off: 5, sA: 0 };
    let total = 0;
    for (let x = -3; x <= 44; x++) for (let y = -3; y <= 4; y++) total += capsule(x + 0.5, y + 0.5, c);
    // six dashes start within 40 px (at 0, 7, ... 35); each is a 2 px strip plus a disc of ink
    const each = 2 * 0.9 + Math.PI * 0.45 * 0.45;
    expect(total / (6 * each)).toBeGreaterThan(0.97);
    expect(total / (6 * each)).toBeLessThan(1.03);
    // nothing in the middle of a gap, full strip in the middle of a dash
    expect(capsule(4.5, 0.5, c)).toBe(0);
    expect(capsule(8, 0.5, c)).toBeCloseTo(0.9, 6);
  });
});
