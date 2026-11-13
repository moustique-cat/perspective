// The scale rail on the right, for any window height.
//
// The design draws the rail for an 820 px tall artboard with literal coordinates. These
// functions compute the same coordinates from the height, so at 820 px they reproduce the
// design's literals exactly (tests/rail.test.ts checks every one of them).
import { LMS, T0, ZMAX, ZMIN } from './design';

/** Space the design leaves above (T0) and below the track: 820 - 748 = 72. */
const TRACK_MARGIN = 72;
/** Height of one landmark button, which is also the closest two may sit. */
const ROW = 17;
/** A landmark moved further than this from its true position gets a leader line. */
const LEADER_FROM = 0.5;

export interface Rail {
  /** Track height in px. */
  th: number;
  /** Track line. */
  tr: string;
  /** One tick per power of ten, longer every fifth. */
  tk: string;
  /** One tick per landmark at its true scale, plus a leader where its label had to move. */
  lt: string;
  /** Baselines of the nine exponent labels, 10^-15 first. */
  ex: string[];
  /** Top of each landmark button, in LMS order. */
  tops: number[];
}

export function trackHeight(H: number): number {
  return H - TRACK_MARGIN;
}

export function railY(z: number, th: number): number {
  return T0 + (ZMAX - z) / (ZMAX - ZMIN) * th;
}

/**
 * Labels want to sit level with their tick but need ROW px each. Runs of labels that would
 * overlap are spread evenly around the centre of where they wanted to be.
 */
function spread(ideal: number[]): number[] {
  // each cluster: first index, count, and the sum of (ideal - offset within cluster)
  const clusters: { from: number; n: number; sum: number }[] = [];
  for (let i = 0; i < ideal.length; i++) {
    let c = { from: i, n: 1, sum: ideal[i] };
    for (;;) {
      const prev = clusters[clusters.length - 1];
      if (!prev || prev.sum / prev.n + prev.n * ROW <= c.sum / c.n) break;
      clusters.pop();
      c = { from: prev.from, n: prev.n + c.n, sum: prev.sum + c.sum - c.n * prev.n * ROW };
    }
    clusters.push(c);
  }
  const out: number[] = [];
  for (const c of clusters) {
    const start = c.sum / c.n;
    for (let k = 0; k < c.n; k++) out[c.from + k] = start + k * ROW;
  }
  return out;
}

const cache = new Map<number, Rail>();

export function railFor(H: number): Rail {
  const hit = cache.get(H);
  if (hit) return hit;
  const th = trackHeight(H);
  let tk = '';
  for (let e = Math.ceil(ZMIN); e <= Math.floor(ZMAX); e++) {
    tk += 'M196 ' + railY(e, th).toFixed(1) + 'H' + (e % 5 === 0 ? 205 : 200);
  }
  const ex: string[] = [];
  for (let e = Math.ceil(ZMIN); e <= Math.floor(ZMAX); e += 5) ex.push((railY(e, th) + 4).toFixed(1));
  const ys = LMS.map((l) => railY(l.z, th));
  const tops = spread(ys.map((y) => y - ROW / 2));
  let lt = '';
  ys.forEach((y, j) => {
    const centre = tops[j] + ROW / 2;
    lt += 'M189 ' + y.toFixed(1) + 'H196';
    if (Math.abs(centre - y) > LEADER_FROM) lt += 'M184 ' + centre.toFixed(1) + 'L189 ' + y.toFixed(1);
  });
  const rail: Rail = {
    th,
    tr: 'M196 ' + T0 + 'V' + (T0 + th),
    tk,
    lt,
    ex,
    tops: tops.map((t) => Number(t.toFixed(1))),
  };
  cache.set(H, rail);
  return rail;
}
