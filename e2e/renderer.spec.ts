// The renderer against the SVG, on identical content.
//
// Two pages of the built site in the same browser: one keeps the SVG (?original) and shows
// only the part of the drawing the renderer replaces; the other runs the renderer, whose
// picture is read back from the chip. Software rendering, so the pictures are the same on
// every machine. (How it does on a real chip is e2e/chip.spec.ts.)
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import { PNG } from 'pngjs';
import { LMS } from '../src/generated/core.js';
import { describeTree, pixelDelta } from './compare';
import { measure, openRenderer, openSvg, rendered, setZoom } from './gpu';

const stops: { name: string; z: number }[] = LMS.map((l: { name: string; z: number }) => ({ name: l.name, z: l.z }));
/**
 * The limits. They are set by how the browser's own software drawing departs from geometry,
 * which the renderer does not (e2e/widths.spec.ts measures both against geometry):
 *
 *   ink     The renderer's total ink at a stop, against the SVG's. Chromium draws small dots
 *           as polygons (3 to 8 % light) and, at 1x, strokes under a pixel wide as hairlines
 *           whose weight falls with their angle (29 % light at 45 degrees). So the renderer
 *           is the darker of the two where dots and thin diagonals dominate, most at 1x.
 *   apart   Share of inked pixels more than a quarter-tone (64 of 255 levels) apart.
 *           Chromium samples these shapes on four rows per pixel, so its edges sit up to an
 *           eighth of a pixel from the truth, and its curves up to a quarter.
 *   alone   Pixels of ink in one picture with no ink within one CSS pixel in the other:
 *           none. Whatever the two make of an edge, every mark is there, and in its place.
 */
const windows = [
  { name: '1280 x 820 at 1x', width: 1280, height: 820, scale: 1, ink: [-6, 14] },
  { name: '1280 x 820 at 2x', width: 1280, height: 820, scale: 2, ink: [-4, 6] },
  { name: 'a phone, 390 x 820 at 3x', width: 390, height: 820, scale: 3, ink: [-4, 8] },
];
const APART = 3;

for (const backend of ['webgl2', 'webgpu']) {
  for (const w of windows) {
    test(`${backend} draws what the SVG draws at every stop on the rail, ${w.name}`, async ({ browser }, info) => {
      const context = await browser.newContext({ viewport: { width: w.width, height: w.height }, deviceScaleFactor: w.scale, reducedMotion: 'reduce' });
      const svg = await context.newPage(), gpu = await context.newPage();
      const problems: string[] = [];
      gpu.on('pageerror', (e) => problems.push(e.message));
      gpu.on('console', (m) => { if (m.type() === 'error' || (m.type() === 'warning' && !/ReadPixels/.test(m.text()))) problems.push(m.text()); });
      await openSvg(svg);
      const running = await openRenderer(gpu, '?gpu=' + backend);
      expect(running, 'the renderer did not take over').not.toBeNull();
      expect(running!.kind).toBe(backend);
      const lines: string[] = [], over: string[] = [];
      for (const stop of stops) {
        await Promise.all([setZoom(svg, stop.z), setZoom(gpu, stop.z)]);
        const a = PNG.sync.read(await svg.screenshot()), b = await rendered(gpu);
        const m = measure(a, b, w.scale);
        const stats = await gpu.evaluate(() => window.__gpu!.stats);
        const ink = 100 * (m.inkGpu / m.inkSvg - 1), apart = 100 * m.over64 / m.inked;
        lines.push(`| ${stop.name} | ${stop.z} | ${m.inkSvg.toFixed(0)} | ${ink.toFixed(1)} % | ${apart.toFixed(2)} % | ${m.alone.svg} / ${m.alone.gpu} | ${m.worst} | ${stats.marks} | ${stats.calls} |`);
        const failed: string[] = [];
        if (ink < w.ink[0] || ink > w.ink[1]) failed.push(`ink ${ink.toFixed(1)} % (limits ${w.ink[0]} to +${w.ink[1]})`);
        if (apart > APART) failed.push(`${apart.toFixed(2)} % of inked pixels more than a quarter-tone apart (limit ${APART})`);
        if (m.alone.svg || m.alone.gpu) failed.push(`${m.alone.svg} pixels of the SVG's ink and ${m.alone.gpu} of the renderer's have no counterpart within a pixel`);
        if (failed.length) {
          over.push(`${stop.name} (zoom ${stop.z}): ${failed.join('; ')}`);
          fs.writeFileSync(info.outputPath(`${w.scale}x-z${stop.z}-difference.png`), m.picture());
        }
      }
      const table = `${backend}, ${w.name}\n| stop | zoom | ink (px) | ink vs SVG | over a quarter-tone apart | ink alone, SVG / renderer | worst pixel | marks | draws |\n|---|---|---|---|---|---|---|---|---|\n` + lines.join('\n');
      fs.writeFileSync(info.outputPath('table.md'), table + '\n');
      console.log('\n  ' + table.replace(/\n/g, '\n  '));
      expect(over, 'beyond the limits').toEqual([]);
      expect(problems).toEqual([]);
      await context.close();
    });
  }
}

const frames = (page: Page, n = 2) => page.evaluate((count) => new Promise<void>((done) => { const step = (left: number): void => { if (left) requestAnimationFrame(() => step(left - 1)); else done(); }; step(count); }), n);
const fontsIn = (page: Page) => page.evaluate(() => new Promise<void>((done) => { const check = () => (document.documentElement.classList.contains('fonts') ? done() : setTimeout(check, 10)); check(); }));

test('both backends draw the same picture', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, reducedMotion: 'reduce' });
  const gl = await context.newPage(), gpu = await context.newPage();
  expect((await openRenderer(gl, '?gpu=webgl2'))!.kind).toBe('webgl2');
  expect((await openRenderer(gpu, '?gpu=webgpu'))!.kind).toBe('webgpu');
  for (const z of [27.35, 21.2, 16.4, 7.4, 6, 3.6, 2.5, 0, -1.8, -4.3, -13.8, -14.35]) {
    await Promise.all([setZoom(gl, z), setZoom(gpu, z)]);
    const m = measure(await rendered(gl), await rendered(gpu));
    // the two run the same arithmetic on the same records; what is left is rounding
    expect(m.worst, `at zoom ${z}`).toBeLessThanOrEqual(2);
  }
  await context.close();
});

test('the takeover: nothing moves when the canvas goes in, then one even fade', async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, reducedMotion: 'no-preference' });
  // hold the fade still, so that its start, middle and end can be photographed
  await context.addInitScript(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
      const animation = animate.apply(this, args);
      if (this.tagName === 'CANVAS') { animation.pause(); (window as unknown as { __fade: Animation }).__fade = animation; }
      return animation;
    };
  });
  const fadeTo = async (page: Page, ms: number): Promise<PNG> => {
    await page.evaluate((t) => { (window as unknown as { __fade: Animation }).__fade.currentTime = t; }, ms);
    await frames(page);
    return PNG.sync.read(await page.screenshot());
  };
  for (const z of [0, 13.2, -3]) {
    const svg = await context.newPage(), page = await context.newPage();
    // both arrive at the zoom as the site itself would: from the other drawing, through the tab's memory
    for (const [p, original] of [[svg, true], [page, false]] as const) await p.addInitScript(({ zoom, o }) => sessionStorage.setItem('perspective', JSON.stringify({ z: zoom, o: !o })), { zoom: z, o: original });
    await svg.goto('/?original');
    await fontsIn(svg);
    await svg.waitForTimeout(400);
    expect((await openRenderer(page, '?gpu=webgl2'))!.kind).toBe('webgl2');
    await fontsIn(page);
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.__perspective!.z)).toBe(z);
    const before = PNG.sync.read(await svg.screenshot());
    const start = await fadeTo(page, 0), middle = await fadeTo(page, 130), end = await fadeTo(page, 259.9);
    await page.evaluate(() => { (window as unknown as { __fade: Animation }).__fade.finish(); return window.__gpu!.handed; });
    await frames(page);
    const after = PNG.sync.read(await page.screenshot());

    // 1. the canvas is in the page, still invisible, and the labels have moved to their own layer: the page looks as it did
    const entering = measure(before, start);
    // 2. the middle of the fade is the average of its two ends, pixel by pixel: an even blend, no dip, no flash
    let uneven = 0;
    for (let i = 0; i < start.data.length; i += 4) uneven = Math.max(uneven, Math.abs(middle.data[i] - (start.data[i] + after.data[i]) / 2));
    // 3. the fade ends on the picture that stays
    const leaving = measure(end, after);
    const whole = measure(before, after);
    console.log(`  zoom ${z}: canvas going in changes ${entering.over16 ? 'MORE THAN 16 levels somewhere' : `at most ${entering.worst} of 255 levels`}; middle of the fade within ${uneven} of the average of its ends; last step ${leaving.worst}; the whole change: worst pixel ${whole.worst}, ink ${(100 * (whole.inkGpu / whole.inkSvg - 1)).toFixed(2)} %`);
    if (entering.worst > 4 || uneven > 2) fs.writeFileSync(info.outputPath(`takeover-z${z}.png`), measure(before, start).picture());
    expect(entering.worst, 'the page changed when the canvas went in').toBeLessThanOrEqual(4);
    expect(uneven, 'the fade is not an even blend').toBeLessThanOrEqual(2);
    expect(leaving.worst, 'the fade does not end on the final picture').toBeLessThanOrEqual(2);
    await svg.close();
    await page.close();
  }
  await context.close();
});

test('after the takeover: the canvas is what is on screen, the SVG drawing rests, the labels still follow', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const requests: string[] = [];
  page.on('request', (r) => requests.push(new URL(r.url()).pathname));
  expect((await openRenderer(page, '?gpu=webgl2'))!.kind).toBe('webgl2');
  await page.evaluate(() => window.__gpu!.handed);
  await fontsIn(page);
  await page.waitForTimeout(600);
  // the page, its fonts, one renderer and its worker: nothing else, and nothing from elsewhere
  expect(requests.map((r) => r.replace(/-[\w-]{8}\.js$/, '.js')).sort()).toEqual(['/', '/fonts/eb-garamond-v33-italic-latin.woff2', '/fonts/eb-garamond-v33-latin.woff2', '/fonts/inter-v20-latin.woff2', '/gpu/levels.js', '/gpu/webgl2.js']);

  await setZoom(page, 13.2);
  const state = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.ink > canvas')!, drawing = document.querySelector<SVGGElement>('.ink > svg g[filter]')!;
    const layer = document.querySelector('[data-layer="outer"]')!, label = Array.from(document.querySelectorAll('.ink > svg text')).find((t) => t.textContent === 'Neptune')!;
    return {
      canvas: [canvas.width, canvas.height, canvas.clientWidth, canvas.clientHeight],
      drawing: drawing.getAttribute('display'),
      // the layer's values are no longer written: it still says what it said at the takeover
      layer: layer.getAttribute('display'),
      label: [label.getAttribute('display'), Number(label.getAttribute('x')) !== 0, !drawing.parentElement!.contains(label)],
      order: Array.from(document.querySelector('.ink')!.children).slice(0, 3).map((e) => e.tagName.toLowerCase()),
    };
  });
  expect(state).toEqual({ canvas: [2560, 1640, 1280, 820], drawing: 'none', layer: 'none', label: ['inline', true, true], order: ['svg', 'canvas', 'svg'] });

  // what the page shows where the drawing is, is exactly what the chip drew
  await page.addStyleTag({ content: '.hdr,.rail,.bl,.ink>canvas~svg{display:none !important}' });
  await frames(page);
  const shown = PNG.sync.read(await page.screenshot()), drawn = await rendered(page);
  expect(measure(shown, drawn).worst).toBeLessThanOrEqual(1);

  // a different window: the canvas follows
  await page.setViewportSize({ width: 900, height: 600 });
  await frames(page, 3);
  expect(await page.evaluate(() => { const c = document.querySelector<HTMLCanvasElement>('.ink > canvas')!; return [c.width, c.height]; })).toEqual([1800, 1200]);
  expect(measure(PNG.sync.read(await page.screenshot()), await rendered(page)).worst).toBeLessThanOrEqual(1);
  await context.close();
});

test('if the chip is taken away, the SVG is back at once, exactly as it was; the renderer returns later', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, reducedMotion: 'reduce' });
  const svg = await context.newPage(), page = await context.newPage();
  await svg.goto('/?original');
  await fontsIn(svg);
  expect((await openRenderer(page, '?gpu=webgl2'))!.kind).toBe('webgl2');
  await page.evaluate(() => window.__gpu!.handed);
  await fontsIn(page);
  await Promise.all([setZoom(svg, 2.5), setZoom(page, 2.5)]);
  await page.evaluate(() => new Promise<void>((done) => {
    const running = window.__gpu!;
    document.querySelector<HTMLCanvasElement>('.ink > canvas')!.getContext('webgl2')!.getExtension('WEBGL_lose_context')!.loseContext();
    running.gone.then(() => done());
  }));
  await frames(page);
  expect(await page.evaluate(() => [window.__gpu, document.querySelectorAll('.ink canvas').length, document.querySelectorAll('.ink > svg').length])).toEqual([null, 0, 1]);
  // the same page as one that never left the SVG: structure, then picture
  expect((await describeTree(page)).join('\n')).toBe((await describeTree(svg)).join('\n'));
  await Promise.all([setZoom(svg, 6), setZoom(page, 6)]);
  expect((await describeTree(page)).join('\n')).toBe((await describeTree(svg)).join('\n'));
  expect(pixelDelta(await svg.screenshot(), await page.screenshot()).differing).toBe(0);
  // and the renderer comes back
  await page.waitForFunction(() => !!window.__gpu, null, { timeout: 15_000 });
  await page.evaluate(() => window.__gpu!.handed);
  expect(await page.evaluate(() => document.querySelectorAll('.ink > canvas').length)).toBe(1);
  await context.close();
});

test('?original and ?hand keep the SVG and fetch no renderer; the zoom carries over between the two drawings', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const requests: string[] = [];
  page.on('request', (r) => requests.push(new URL(r.url()).pathname));
  for (const query of ['?original', '?hand=1', '?gpu=svg']) {
    expect(await openRenderer(page, query), query).toBeNull();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.querySelectorAll('canvas').length), query).toBe(0);
  }
  expect(requests.filter((r) => r.startsWith('/gpu/'))).toEqual([]);

  // from the renderer's drawing to the original at the same zoom, and back
  expect((await openRenderer(page, '?gpu=webgl2'))!.kind).toBe('webgl2');
  await setZoom(page, 13.2);
  await openRenderer(page, '?original');
  expect(await page.evaluate(() => window.__perspective!.z)).toBe(13.2);
  await setZoom(page, -4.3);
  await openRenderer(page, '?gpu=webgl2');
  expect(await page.evaluate(() => window.__perspective!.z)).toBe(-4.3);
  // a reload, or an ordinary visit, starts at Moustique
  await page.reload();
  await page.waitForFunction(() => !!window.__perspective);
  expect(await page.evaluate(() => window.__perspective!.z)).toBe(0);
  await openRenderer(page, '?original');
  await setZoom(page, 5);
  await openRenderer(page, '?original');
  expect(await page.evaluate(() => window.__perspective!.z)).toBe(0);
  await context.close();
});

test('the comparison can tell: a picture two pixels out of place, or strokes a sixth too wide, are caught', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const svg = await context.newPage();
  await openSvg(svg);
  const reference = PNG.sync.read(await svg.screenshot());
  const withFault = async (fault: { wider?: number; moved?: number }) => {
    const page = await context.newPage();
    await page.addInitScript((f) => { window.__fault = f; }, fault);
    expect(await openRenderer(page, '?gpu=webgl2')).not.toBeNull();
    const m = measure(reference, await rendered(page), 2);
    await page.close();
    return m;
  };
  const sound = await withFault({});
  expect(sound.alone).toEqual({ svg: 0, gpu: 0 });
  // moved by two CSS pixels: ink on both sides is left without a counterpart
  const moved = await withFault({ moved: 4 });
  expect(moved.alone.svg).toBeGreaterThan(1000);
  expect(moved.alone.gpu).toBeGreaterThan(1000);
  // strokes a sixth too wide: the ink goes beyond its limit
  const wider = await withFault({ wider: 7 / 6 });
  expect(100 * (wider.inkGpu / wider.inkSvg - 1)).toBeGreaterThan(windows[1].ink[1]);
  await context.close();
});
