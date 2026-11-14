// Measured line width.
//
// The drawing is swapped for marks of known size, in the design's own classes: straight
// strokes at seven angles, circles, dashed lines, and dots at scattered positions. The SVG
// and the renderer both draw them; the ink each puts down is measured and set against what
// the geometry says: width x length, plus the round ends, times the opacity.
//
// A stroke's width is its ink divided by its length, so this is the direct check that the
// design's line weights and dot sizes survive, at 1x, 2x and 3x.
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import { PNG } from 'pngjs';
import { ONLY_THE_DRAWING, openRenderer, rendered } from './gpu';

interface Mark { id: string; kind: 'stroke' | 'dots' | 'dashed' | 'ring'; cls: string; nominal: number }

/** The stroke styles of the design: width in px, opacity. */
const STYLE: Record<string, [number, number]> = { ln: [1.25, 1], thin: [0.85, 1], faint: [0.8, 0.42], dash: [0.9, 0.55], pt: [2, 1], pts: [1.4, 1], ptl: [3.4, 1], ptx: [5.5, 1] };
const ANGLES = [0, 7, 30, 45, 60, 83, 90];
const LENGTH = 60, RING = 30, DASHED = 140;

/** Replaces the drawing with the test marks, once the page's own markup is in. Runs in the page. */
function swapDrawing({ angles, length, ring, dashed }: { angles: number[]; length: number; ring: number; dashed: number }): void {
  document.addEventListener('DOMContentLoaded', () => {
    const marks: { id: string; cls: string; d: string }[] = [];
    let col = 0, row = 0;
    const cell = (): [number, number] => { const at: [number, number] = [-370 + 100 * col, -195 + 92 * row]; if (++col > 7) { col = 0; row++; } return at; };
    for (const cls of ['ln', 'thin', 'faint']) {
      for (const a of angles) {
        const [x, y] = cell(), dx = Math.cos(a * Math.PI / 180) * length / 2, dy = Math.sin(a * Math.PI / 180) * length / 2;
        marks.push({ id: `${cls} stroke at ${a} degrees`, cls, d: `M${(x - dx + 0.37).toFixed(3)} ${(y - dy + 0.21).toFixed(3)}L${(x + dx + 0.37).toFixed(3)} ${(y + dy + 0.21).toFixed(3)}` });
      }
      const [x, y] = cell();
      marks.push({ id: `${cls} circle`, cls, d: `M${x - ring} ${y + 0.3}A${ring} ${ring} 0 1 0 ${x + ring} ${y + 0.3}A${ring} ${ring} 0 1 0 ${x - ring} ${y + 0.3}Z` });
    }
    for (const cls of ['pt', 'pts', 'ptl', 'ptx']) {
      const [x, y] = cell();
      let d = '';
      for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) d += `M${(x - 28 + 14 * i + 0.137 * (i * 5 + j)).toFixed(3)} ${(y - 28 + 14 * j + 0.291 * (i + j * 5)).toFixed(3)}h0`;
      marks.push({ id: `${cls} dots`, cls, d });
    }
    col = 0; row++;
    for (const a of [0, 30, 45, 90]) {
      col = [0, 2, 4, 6][[0, 30, 45, 90].indexOf(a)];
      const at: [number, number] = [-370 + 100 * col + 50, -195 + 92 * row + 40], dx = Math.cos(a * Math.PI / 180) * dashed / 2, dy = Math.sin(a * Math.PI / 180) * dashed / 2;
      marks.push({ id: `dashed line at ${a} degrees`, cls: 'dash', d: `M${(at[0] - dx + 0.19).toFixed(3)} ${(at[1] - dy + 0.43).toFixed(3)}L${(at[0] + dx + 0.19).toFixed(3)} ${(at[1] + dy + 0.43).toFixed(3)}` });
    }
    for (const g of Array.from(document.querySelectorAll('[data-layer]'))) {
      g.replaceChildren();
      if (g.getAttribute('data-layer') !== 'winstars') continue;
      for (const m of marks) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('class', m.cls);
        path.setAttribute('d', m.d);
        path.setAttribute('data-mark', m.id);
        g.appendChild(path);
      }
    }
  });
}

function marksFor(): Mark[] {
  const out: Mark[] = [];
  const line = (cls: string, l: number): number => { const [w, o] = STYLE[cls]; return (w * l + Math.PI * w * w / 4) * o; };
  for (const cls of ['ln', 'thin', 'faint']) {
    for (const a of ANGLES) out.push({ id: `${cls} stroke at ${a} degrees`, kind: 'stroke', cls, nominal: line(cls, LENGTH) });
    out.push({ id: `${cls} circle`, kind: 'ring', cls, nominal: 2 * Math.PI * RING * STYLE[cls][0] * STYLE[cls][1] });
  }
  for (const cls of ['pt', 'pts', 'ptl', 'ptx']) out.push({ id: `${cls} dots`, kind: 'dots', cls, nominal: 25 * Math.PI * STYLE[cls][0] * STYLE[cls][0] / 4 });
  // dashes start every 7 px, each 2 px long with round ends; 140 px holds exactly 20
  for (const a of [0, 30, 45, 90]) out.push({ id: `dashed line at ${a} degrees`, kind: 'dashed', cls: 'dash', nominal: 20 * line('dash', 2) });
  return out;
}

/** The ink inside each mark's box in a picture, in fully inked CSS pixels. */
function inkIn(picture: PNG, boxes: Record<string, [number, number, number, number]>, scale: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id in boxes) {
    const [l, t, r, b] = boxes[id].map((v) => Math.round(v * scale));
    let ink = 0;
    for (let y = Math.max(0, t); y < Math.min(picture.height, b); y++) for (let x = Math.max(0, l); x < Math.min(picture.width, r); x++) ink += 255 - picture.data[4 * (y * picture.width + x)];
    out[id] = ink / 235 / (scale * scale);
  }
  return out;
}

async function open(page: Page, query: string, fault?: { wider?: number; moved?: number }): Promise<void> {
  await page.addInitScript(swapDrawing, { angles: ANGLES, length: LENGTH, ring: RING, dashed: DASHED });
  // arrive at the zoom where the test layer is at scale 1: one unit is one CSS pixel
  await page.addInitScript((original) => sessionStorage.setItem('perspective', JSON.stringify({ z: 0.3, o: !original })), /original/.test(query));
  if (fault) await page.addInitScript((f) => { window.__fault = f; }, fault);
  const running = await openRenderer(page, query);
  if (!/original/.test(query)) expect(running, 'the renderer did not take over').not.toBeNull();
  expect(await page.evaluate(() => [window.__perspective!.z, document.querySelector('[data-layer="winstars"]')!.getAttribute('transform')])).toEqual([0.3, 'scale(1.00000)']);
}

for (const scale of [1, 2, 3]) {
  test(`strokes and dots keep their size, at ${scale}x`, async ({ browser }, info) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: scale, reducedMotion: 'reduce' });
    const svg = await context.newPage(), gpu = await context.newPage();
    await open(svg, '?original');
    await svg.addStyleTag({ content: ONLY_THE_DRAWING });
    await open(gpu, '?gpu=webgl2');
    // where each mark is on screen, with room for its stroke
    const boxes = await svg.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll('[data-mark]')).map((el) => {
      const r = el.getBoundingClientRect();
      return [el.getAttribute('data-mark'), [r.left - 8, r.top - 8, r.right + 8, r.bottom + 8]];
    }))) as Record<string, [number, number, number, number]>;
    await svg.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    const a = inkIn(PNG.sync.read(await svg.screenshot()), boxes, scale), b = inkIn(await rendered(gpu), boxes, scale);
    const marks = marksFor();
    const lines = marks.map((m) => `| ${m.id} | ${m.nominal.toFixed(2)} | ${a[m.id].toFixed(2)} | ${b[m.id].toFixed(2)} | ${(100 * (a[m.id] / m.nominal - 1)).toFixed(1)} % | ${(100 * (b[m.id] / m.nominal - 1)).toFixed(1)} % |`);
    const table = `Ink per mark at ${scale}x, in fully inked CSS pixels\n| mark | by geometry | SVG | renderer | SVG off by | renderer off by |\n|---|---|---|---|---|---|\n` + lines.join('\n');
    fs.writeFileSync(info.outputPath('widths.md'), table + '\n');
    console.log('\n  ' + table.replace(/\n/g, '\n  '));
    for (const m of marks) {
      expect(boxes[m.id], m.id).toBeTruthy();
      // the renderer against geometry: strokes, circles and dots within 1.5 %; a row of dashes, whose forty round ends are approximated, within 4 %
      expect(Math.abs(b[m.id] / m.nominal - 1), `${m.id}: the renderer inked ${b[m.id].toFixed(2)} px, geometry says ${m.nominal.toFixed(2)}`).toBeLessThan(m.kind === 'dashed' ? 0.04 : 0.015);
    }
    await context.close();
  });
}

test('the measurement can tell: strokes drawn 4 % too wide are caught', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const svg = await context.newPage(), gpu = await context.newPage();
  await open(svg, '?original');
  await open(gpu, '?gpu=webgl2', { wider: 1.04 });
  const boxes = await svg.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll('[data-mark]')).map((el) => {
    const r = el.getBoundingClientRect();
    return [el.getAttribute('data-mark'), [r.left - 8, r.top - 8, r.right + 8, r.bottom + 8]];
  }))) as Record<string, [number, number, number, number]>;
  const b = inkIn(await rendered(gpu), boxes, 2);
  const off = marksFor().filter((m) => m.kind !== 'dashed').map((m) => b[m.id] / m.nominal - 1);
  expect(Math.min(...off), 'every stroke and dot is beyond the limit').toBeGreaterThan(0.015);
  await context.close();
});
