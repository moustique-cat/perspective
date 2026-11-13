// Helpers for the renderer's tests: the renderer's picture, the SVG's picture of the same
// marks, and how to measure one against the other.
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';

/** Everything that is not the drawing the renderer replaces: words, rail, labels, Sun, marker. */
export const ONLY_THE_DRAWING = '.hdr,.rail,.bl{display:none !important}.ink>svg>g>:not(:first-child){display:none !important}';

/** Opens the site with the SVG drawing only (?original), reduced to the marks the renderer draws. */
export async function openSvg(page: Page, query = ''): Promise<void> {
  await page.goto('/?original' + query);
  await page.evaluate(() => new Promise<void>((done) => { const check = () => (window.__perspective && window.__gpu === null ? done() : setTimeout(check, 10)); check(); }));
  await page.addStyleTag({ content: ONLY_THE_DRAWING });
}

/** Opens the site and waits for the renderer to take over. Returns what it runs on, or null if it stayed with the SVG. */
export async function openRenderer(page: Page, query: string): Promise<{ kind: string; chip: string } | null> {
  await page.goto('/' + query);
  return page.evaluate(() => new Promise<{ kind: string; chip: string } | null>((done) => {
    const check = () => (window.__gpu !== undefined ? done(window.__gpu ? { kind: window.__gpu.kind, chip: window.__gpu.chip } : null) : setTimeout(check, 10));
    check();
  }));
}

export async function setZoom(page: Page, z: number): Promise<void> {
  await page.evaluate((zz) => new Promise<void>((done) => {
    window.__perspective!.setZ(zz);
    requestAnimationFrame(() => requestAnimationFrame(() => done()));
  }), z);
}

/** The picture the chip drew for the current zoom, with every level it wants in place. */
export async function rendered(page: Page): Promise<PNG> {
  const data = await page.evaluate(async () => { await window.__gpu!.settled(); return window.__gpu!.snapshot(); });
  return PNG.sync.read(Buffer.from(data.split(',')[1], 'base64'));
}

export interface Measure {
  /** Total darkness of each picture, in fully inked pixels. */
  inkSvg: number;
  inkGpu: number;
  /** Pixels with any ink in either picture. */
  inked: number;
  /** Pixels differing by more than 16, 32, 64 and 128 of 255 levels. */
  over16: number;
  over32: number;
  over64: number;
  over128: number;
  worst: number;
  /** The same after averaging each picture over 3 x 3 pixels: differences of place, not of smoothing. */
  soft: { over16: number; over32: number; worst: number };
  /** The SVG's picture faded, with the differences on it: red where the renderer is darker, blue where lighter. */
  picture(): Buffer;
}

/** `paper` and `ink` are the red values of an empty and a fully inked pixel. */
export function measure(svg: PNG, gpu: PNG, ink = 20, paper = 255): Measure {
  if (svg.width !== gpu.width || svg.height !== gpu.height) throw new Error(`the pictures differ in size: ${svg.width} x ${svg.height} and ${gpu.width} x ${gpu.height}`);
  const w = svg.width, h = svg.height, full = paper - ink;
  const a = new Float32Array(w * h), b = new Float32Array(w * h);
  const m = { inkSvg: 0, inkGpu: 0, inked: 0, over16: 0, over32: 0, over64: 0, over128: 0, worst: 0, soft: { over16: 0, over32: 0, worst: 0 } };
  for (let i = 0; i < w * h; i++) {
    a[i] = paper - svg.data[4 * i]; b[i] = paper - gpu.data[4 * i];
    m.inkSvg += a[i]; m.inkGpu += b[i];
    if (a[i] > 8 || b[i] > 8) m.inked++;
    const d = Math.abs(a[i] - b[i]);
    if (d > 16) m.over16++;
    if (d > 32) m.over32++;
    if (d > 64) m.over64++;
    if (d > 128) m.over128++;
    if (d > m.worst) m.worst = d;
  }
  m.inkSvg /= full; m.inkGpu /= full;
  // 3 x 3 box average of the difference, by running sums
  const diff = new Float32Array(w * h), rows = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) diff[i] = b[i] - a[i];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows[y * w + x] = (x > 0 ? diff[y * w + x - 1] : 0) + diff[y * w + x] + (x < w - 1 ? diff[y * w + x + 1] : 0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.abs(((y > 0 ? rows[(y - 1) * w + x] : 0) + rows[y * w + x] + (y < h - 1 ? rows[(y + 1) * w + x] : 0)) / 9);
    if (d > 16) m.soft.over16++;
    if (d > 32) m.soft.over32++;
    if (d > m.soft.worst) m.soft.worst = d;
  }
  return {
    ...m,
    picture(): Buffer {
      const out = new PNG({ width: w, height: h });
      for (let i = 0; i < w * h; i++) {
        const d = b[i] - a[i], grey = 255 - a[i] / 3, strength = Math.min(1, Math.abs(d) / 64);
        out.data[4 * i] = d > 0 ? grey + (255 - grey) * strength : grey * (1 - strength);
        out.data[4 * i + 1] = grey * (1 - strength);
        out.data[4 * i + 2] = d < 0 ? grey + (255 - grey) * strength : grey * (1 - strength);
        out.data[4 * i + 3] = 255;
      }
      return PNG.sync.write(out);
    },
  };
}

export const percent = (part: number, whole: number): string => (whole ? (100 * part / whole).toFixed(2) : '0.00') + ' %';
