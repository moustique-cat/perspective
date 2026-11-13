// The speed report: add ?bench to the address.
//
// One scripted zoom from proton to edge, one fixed step per frame, the same on every run and
// every device, timing every frame. It reports the spread of frame times, the worst frame
// and where it fell, and the most marks drawn in a frame, as a block of text to copy.
// `npm run bench` runs this same code in a test browser.
//
// A separate file, fetched only when ?bench is in the address.

const STEP = 0.02;

export interface BenchReport {
  when: string;
  agent: string;
  /** Window in CSS px, its pixel ratio. */
  window: [number, number, number];
  /** What drew the flight: the renderer's backend and chip, or the SVG. */
  drawnBy: string;
  /** Time between frames at rest, ms: the display's refresh. */
  refresh: number;
  frames: number;
  seconds: number;
  median: number;
  p95: number;
  p99: number;
  worst: number;
  worstAt: number;
  /** Frames that took more than one and a half refreshes: a refresh was missed. */
  late: number;
  over50: number;
  /** Where the late frames were, by power of ten: [exponent, worst frame there]. */
  lateAt: [number, number][];
  marks: number;
  draws: number;
  /** Seconds from the start of navigation; null where it does not apply. */
  loading: { painted: number | null; zoomable: number | null; renderer: number | null; allLevels: number | null };
}

const nextFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));
const quantile = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const mark = (name: string): number | null => {
  const entry = performance.getEntriesByName(name)[0];
  return entry ? entry.startTime / 1000 : null;
};

export async function measure(ZMIN: number, ZMAX: number): Promise<BenchReport> {
  // wait until it is settled what draws the page, and the renderer (if any) has everything it will ever need
  while (window.__gpu === undefined || !window.__perspective) await new Promise((r) => setTimeout(r, 50));
  const journey = window.__perspective, gpu = window.__gpu;
  if (gpu) { await gpu.handed; await gpu.idle(); }
  await new Promise((r) => setTimeout(r, 300));

  const rest: number[] = [];
  for (let last = await nextFrame(), i = 0; i < 40; i++) { const now = await nextFrame(); rest.push(now - last); last = now; }
  const refresh = quantile(rest.sort((a, b) => a - b), 0.5);

  const n = Math.round((ZMAX - ZMIN) / STEP);
  const frames: number[] = [], zooms: number[] = [];
  let marks = 0, draws = 0;
  const started = performance.now();
  await new Promise<void>((resolve) => {
    let i = 0, last = 0;
    const frame = (ts: number): void => {
      if (last) frames.push(ts - last);
      last = ts;
      if (gpu) { marks = Math.max(marks, gpu.stats.marks); draws = Math.max(draws, gpu.stats.calls); }
      if (i > n) { resolve(); return; }
      const z = ZMIN + i++ * STEP;
      zooms.push(z);
      journey.setZ(z);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const seconds = (performance.now() - started) / 1000;
  journey.setZ(0);

  const sorted = [...frames].sort((a, b) => a - b);
  const lateFrom = refresh * 1.5;
  const lateAt = new Map<number, number>();
  let worstAt = 0;
  frames.forEach((dt, i) => {
    if (dt === sorted[sorted.length - 1]) worstAt = zooms[i];
    if (dt > lateFrom) { const k = Math.floor(zooms[i]); lateAt.set(k, Math.max(lateAt.get(k) || 0, dt)); }
  });
  const paint = performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint');
  return {
    when: new Date().toISOString(),
    agent: navigator.userAgent,
    window: [innerWidth, innerHeight, devicePixelRatio],
    drawnBy: gpu ? `${gpu.kind} on ${gpu.chip}` : 'SVG',
    refresh,
    frames: frames.length,
    seconds,
    median: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), p99: quantile(sorted, 0.99), worst: sorted[sorted.length - 1], worstAt,
    late: frames.filter((dt) => dt > lateFrom).length,
    over50: frames.filter((dt) => dt > 50).length,
    lateAt: [...lateAt.entries()].sort((a, b) => a[0] - b[0]),
    marks, draws,
    loading: { painted: paint ? paint.startTime / 1000 : null, zoomable: mark('zoomable'), renderer: mark('renderer'), allLevels: mark('levels') },
  };
}

export function asText(r: BenchReport): string {
  const ms = (n: number) => n.toFixed(1), s = (n: number | null) => (n === null ? 'n/a' : n.toFixed(2) + ' s');
  return [
    `Perspective speed report, ${r.when}`,
    `browser: ${r.agent}`,
    `window: ${r.window[0]} x ${r.window[1]} at ${r.window[2]}x`,
    `drawn by: ${r.drawnBy}`,
    `refresh: ${ms(r.refresh)} ms (${Math.round(1000 / r.refresh)} Hz)`,
    `flight: ${r.frames} frames in ${r.seconds.toFixed(1)} s`,
    `frame times (ms): median ${ms(r.median)}, 95th ${ms(r.p95)}, 99th ${ms(r.p99)}, worst ${ms(r.worst)} at 10^${r.worstAt.toFixed(1)} m`,
    `late frames (over ${ms(r.refresh * 1.5)} ms): ${r.late} of ${r.frames} (${(100 * r.late / r.frames).toFixed(2)} %); over 50 ms: ${r.over50}`,
    `late frames are at: ${r.lateAt.map(([k, worst]) => `10^${k} m (${worst.toFixed(0)} ms)`).join(', ') || 'none'}`,
    `most marks in a frame: ${r.marks}; most draws: ${r.draws}`,
    `loading: first paint ${s(r.loading.painted)}, zoomable ${s(r.loading.zoomable)}, renderer in ${s(r.loading.renderer)}, every level built ${s(r.loading.allLevels)}`,
  ].join('\n');
}

declare global {
  interface Window { __bench?: Promise<BenchReport> }
}

/** Runs the flight between the design's two ends and shows the report over the page, to be copied. */
export function run(zmin: number, zmax: number): void {
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;left:12px;top:12px;right:12px;max-width:720px;z-index:9;background:#FFFFFF;color:#141414;border:1px solid #141414;border-radius:8px;padding:14px 16px;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;box-shadow:0 2px 12px rgba(0,0,0,.15)';
  panel.textContent = 'Measuring: one flight from proton to edge, about 40 seconds. Please leave the page alone until this box changes.';
  document.body.appendChild(panel);
  window.__bench = measure(zmin, zmax);
  window.__bench.then((report) => {
    const text = asText(report);
    panel.textContent = text + '\n\n';
    const copy = document.createElement('button');
    copy.textContent = 'Copy this report';
    copy.style.cssText = 'font:inherit;padding:6px 12px;border:1px solid #141414;border-radius:6px;background:#FFFFFF;color:inherit';
    copy.onclick = () => {
      const done = (): void => { copy.textContent = 'Copied'; };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => { getSelection()!.selectAllChildren(panel); });
      else getSelection()!.selectAllChildren(panel);
    };
    panel.appendChild(copy);
  }, (e) => { panel.textContent = 'The measurement failed: ' + e; });
}
