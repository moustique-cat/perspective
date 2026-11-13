// Comparing the built site with the original artboard, in two independent ways.
//
// 1. Structure: every element, attribute, inline style, text, computed style and on-screen box
//    must be exactly equal. This is deterministic and has no tolerance.
// 2. Picture: screenshots of the two pages. They are normally bit-identical. The exception is
//    Chromium's own compositing: it sometimes draws a translucent group through an
//    intermediate layer, which lands a fraction of a pixel softer. Whether it does depends on
//    details of the page that have nothing to do with the drawing, so the two pages can
//    disagree at an isolated zoom (so far: one, where the "Moustique is here" ring is fading
//    in, on a wide window). Such a difference keeps the amount of ink the same and only
//    redistributes it between neighbouring pixels; that is what is allowed, and only rarely.
//    A real difference (a stroke width, a colour, a missing mark) changes the amount of ink.
import type { Page, TestInfo } from '@playwright/test';
import fs from 'node:fs';
import { PNG } from 'pngjs';

export interface PixelDelta {
  /** Pixels that are not identical. */
  differing: number;
  /** Largest difference in any channel, 0 to 255. */
  worst: number;
  /** Total darkness of each picture (sum of 255 - red over all pixels). */
  inkA: number;
  inkB: number;
  /** Where the differing pixels are: left, top, right, bottom. */
  box: [number, number, number, number] | null;
  picture: Buffer | null;
}

export function pixelDelta(a: Buffer, b: Buffer): PixelDelta {
  if (a.equals(b)) return { differing: 0, worst: 0, inkA: 0, inkB: 0, box: null, picture: null };
  const pa = PNG.sync.read(a), pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return { differing: pa.width * pa.height, worst: 255, inkA: 0, inkB: 1, box: null, picture: null };
  const out = new PNG({ width: pa.width, height: pa.height });
  let differing = 0, worst = 0, inkA = 0, inkB = 0;
  const box: [number, number, number, number] = [pa.width, pa.height, -1, -1];
  for (let i = 0; i < pa.data.length; i += 4) {
    const d = Math.max(Math.abs(pa.data[i] - pb.data[i]), Math.abs(pa.data[i + 1] - pb.data[i + 1]), Math.abs(pa.data[i + 2] - pb.data[i + 2]), Math.abs(pa.data[i + 3] - pb.data[i + 3]));
    if (d) {
      differing++;
      const x = (i / 4) % pa.width, y = Math.floor(i / 4 / pa.width);
      if (x < box[0]) box[0] = x;
      if (y < box[1]) box[1] = y;
      if (x > box[2]) box[2] = x;
      if (y > box[3]) box[3] = y;
    }
    if (d > worst) worst = d;
    inkA += 255 - pa.data[i];
    inkB += 255 - pb.data[i];
    // the original, faded, with every differing pixel in red
    const grey = 255 - Math.round((255 - pa.data[i]) / 3);
    out.data[i] = d ? 255 : grey; out.data[i + 1] = d ? 0 : grey; out.data[i + 2] = d ? 0 : grey; out.data[i + 3] = 255;
  }
  return { differing, worst, inkA, inkB, box: differing ? box : null, picture: differing ? PNG.sync.write(out) : null };
}

/** The most a compositing difference has been seen to move a pixel, with a little headroom. */
export const SOFT_LEVELS = 20;
/** Two pictures of the same drawing hold the same ink to within this fraction. */
export const SAME_INK = 0.0005;

/** True if two pictures differ only by ink shifting between neighbouring pixels. */
export function sameInk(d: PixelDelta): boolean {
  return d.worst <= SOFT_LEVELS && Math.abs(d.inkA - d.inkB) <= SAME_INK * Math.max(d.inkA, d.inkB, 1);
}

/** Wait until the page has painted its current state. */
export async function settled(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

/** Make the page draw its current state from scratch rather than reuse parts of earlier frames. */
export async function repaint(page: Page): Promise<void> {
  await page.evaluate(() => {
    const ink = document.querySelector<HTMLElement>('.ink')!;
    const display = ink.style.display;
    ink.style.display = 'none';
    void ink.offsetWidth;
    ink.style.display = display;
  });
  await settled(page);
}

/**
 * Everything that decides what is drawn, one line per element: markup, text, the computed
 * styles that matter to this design, and the element's box on screen.
 */
export function describeTree(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const STYLES = ['display', 'visibility', 'opacity', 'color', 'fill', 'stroke', 'strokeWidth', 'strokeOpacity', 'strokeDasharray', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'backgroundColor', 'borderTopColor', 'borderLeftColor', 'textShadow', 'filter', 'transform'] as const;
    const SITE_ONLY = /^data-(b|e|layer)$/;
    const digest = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return s.length + '#' + (h >>> 0).toString(36); };
    const lines: string[] = [];
    const walk = (node: Node, depth: number): void => {
      if (node.nodeType === 3) {
        const text = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
        if (text) lines.push(' '.repeat(depth) + JSON.stringify(text));
        return;
      }
      if (!(node instanceof Element)) return;
      // the reference keeps the design's <sc-for> wrapper around the landmark buttons
      if (node.tagName === 'SC-FOR') { node.childNodes.forEach((c) => walk(c, depth)); return; }
      const attrs = Array.from(node.attributes).filter((a) => !SITE_ONLY.test(a.name)).map((a) => {
        let v = a.value;
        if (a.name === 'style') v = (node as HTMLElement).style.cssText;
        if (a.name === 'value') v = (node as HTMLInputElement).value;
        if (a.name === 'd' && v.length > 80) v = digest(v);
        return a.name + '=' + v;
      }).sort().join(' | ');
      const cs = getComputedStyle(node);
      const shown = cs.display !== 'none';
      const r = node.getBoundingClientRect();
      const box = shown ? [r.x, r.y, r.width, r.height].map((n) => n.toFixed(2)).join(',') : '-';
      lines.push(' '.repeat(depth) + node.tagName.toLowerCase() + ' [' + attrs + '] {' + STYLES.map((p) => cs[p]).join(';') + '} @' + box);
      node.childNodes.forEach((c) => walk(c, depth + 1));
    };
    walk(document.querySelector('.ink')!, 0);
    return lines;
  });
}

/**
 * Browsers fetch a font face the first time some text needs it (the italic only at the proton),
 * then swap it in. Loading every face up front keeps a comparison from catching one page
 * before the swap and the other after.
 */
async function fontsIn(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const faces = ["400 16px 'EB Garamond'", "500 16px 'EB Garamond'", "italic 400 16px 'EB Garamond'", '400 13px Inter', '500 13px Inter', '600 13px Inter'];
    await Promise.all(faces.map((f) => document.fonts.load(f, 'ud10⁰’')));
    await document.fonts.ready;
  });
  await settled(page);
}

export async function openReference(page: Page, query = ''): Promise<void> {
  await page.goto('/__reference/' + query);
  await fontsIn(page);
}

export async function openSite(page: Page, query = ''): Promise<void> {
  await page.goto('/' + query);
  await page.waitForFunction(() => document.documentElement.classList.contains('fonts') && !!window.__perspective);
  await fontsIn(page);
}

export const setReferenceZoom = (page: Page, z: number) => page.evaluate((zz) => (window as unknown as { __ref: { setZ(z: number): void } }).__ref.setZ(zz), z);
export const setSiteZoom = (page: Page, z: number) => page.evaluate((zz) => window.__perspective!.setZ(zz), z);

export interface Comparison {
  compared: number;
  /** Zooms at which the two page structures are not exactly equal. */
  structure: string[];
  /** Zooms at which the pictures differ in the amount of ink, or by more than a soft edge. */
  pixels: string[];
  /** Zooms at which the pictures hold the same ink but are not bit-identical. */
  soft: string[];
  /** Zooms at which the screenshots are bit-identical. */
  identical: number;
}

export async function compareAcross(reference: Page, site: Page, zooms: number[], info: TestInfo): Promise<Comparison> {
  const result: Comparison = { compared: zooms.length, structure: [], pixels: [], soft: [], identical: 0 };
  for (const z of zooms) {
    await Promise.all([setReferenceZoom(reference, z), setSiteZoom(site, z)]);
    await Promise.all([repaint(reference), repaint(site)]);

    const [theirs, ours] = await Promise.all([describeTree(reference), describeTree(site)]);
    if (theirs.join('\n') !== ours.join('\n')) {
      const at = theirs.findIndex((line, i) => line !== ours[i]);
      result.structure.push(`z = ${z}: ${theirs.length} vs ${ours.length} nodes, first difference at node ${at}\n  original: ${(theirs[at] || '(missing)').trim().slice(0, 600)}\n  site:     ${(ours[at] || '(missing)').trim().slice(0, 600)}`);
    }

    const [a, b] = [await reference.screenshot(), await site.screenshot()];
    const delta = pixelDelta(a, b);
    if (delta.differing === 0) { result.identical++; continue; }
    const note = `z = ${z}: ${delta.differing} px differ by up to ${delta.worst} levels, within x ${delta.box![0]}..${delta.box![2]}, y ${delta.box![1]}..${delta.box![3]}; ink ${delta.inkA} vs ${delta.inkB}`;
    // keep the pictures of anything that is not bit-identical (CI uploads them when a test fails)
    if (result.soft.length + result.pixels.length < 4) {
      fs.writeFileSync(info.outputPath(`z${z}-original.png`), a);
      fs.writeFileSync(info.outputPath(`z${z}-site.png`), b);
      if (delta.picture) fs.writeFileSync(info.outputPath(`z${z}-difference.png`), delta.picture);
    }
    if (sameInk(delta)) { result.soft.push(note); continue; }
    result.pixels.push(note);
  }
  return result;
}

export function summary(r: Comparison): string {
  return `${r.compared} zooms: structure equal at ${r.compared - r.structure.length}, pictures bit-identical at ${r.identical}` +
    (r.soft.length ? `, same ink but softer edges at ${r.soft.length} (${r.soft.join('; ')})` : '') +
    (r.pixels.length ? `, DIFFERENT at ${r.pixels.length}` : '');
}
