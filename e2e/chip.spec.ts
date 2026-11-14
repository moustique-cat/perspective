// What only a real graphics chip can show: that the site takes the renderer path by itself,
// how fast it then draws, and how its picture sits next to the SVG as that chip draws it.
//
// The other specs run in software so that their pictures are the same on every machine.
// These launch their own browsers, asked for the chip, and skip themselves where there is
// none (a CI machine). Speed figures are reported, not judged here: `npm run bench` is the
// speed report.
import { chromium, expect, test, type Browser, type LaunchOptions, type Page } from '@playwright/test';
import fs from 'node:fs';
import { PNG } from 'pngjs';
import { LMS } from '../src/generated/core.js';
import { measure, openRenderer, openSvg, percent, rendered, setZoom } from './gpu';

const ZMIN = -15, ZMAX = 27.9;
const onChip: LaunchOptions = {
  args: [...(process.platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=default', '--enable-gpu']), '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
  ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
};
const ways: [string, LaunchOptions][] = [
  ['headless', onChip],
  ['in a window', { ...onChip, headless: false }],
];

/**
 * A browser launched this way, if it launches at all and draws with a graphics chip.
 * Otherwise null, and the reason: a machine without a chip (a CI runner) skips these tests.
 */
async function launch(options: LaunchOptions, baseURL: string | undefined): Promise<{ browser: Browser | null; why: string }> {
  let browser: Browser;
  try { browser = await chromium.launch({ timeout: 30_000, ...options }); } catch { return { browser: null, why: 'this way of launching is not available here' }; }
  const page = await browser.newPage({ baseURL });
  await page.goto('/fonts/OFL-Inter.txt');
  const drawsWith = await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'); const e = gl && gl.getExtension('WEBGL_debug_renderer_info'); return gl && e ? String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : 'no WebGL2'; });
  await page.close();
  if (/swiftshader|llvmpipe|software|no WebGL2/i.test(drawsWith)) { await browser.close(); return { browser: null, why: 'no graphics chip here: ' + drawsWith }; }
  return { browser, why: '' };
}

/** One fixed step of zoom per frame from proton to edge; the time between frames, and the most marks in a frame. */
async function flight(page: Page, step: number): Promise<{ frames: number[]; marks: number; draws: number }> {
  return page.evaluate(({ ZMIN, ZMAX, step }) => new Promise<{ frames: number[]; marks: number; draws: number }>((resolve) => {
    const n = Math.round((ZMAX - ZMIN) / step), frames: number[] = [];
    let i = 0, last = 0, marks = 0, draws = 0;
    const frame = (ts: number): void => {
      if (last) frames.push(ts - last);
      last = ts;
      if (window.__gpu) { marks = Math.max(marks, window.__gpu.stats.marks); draws = Math.max(draws, window.__gpu.stats.calls); }
      if (i > n) { resolve({ frames, marks, draws }); return; }
      window.__perspective!.setZ(ZMIN + i++ * step);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }), { ZMIN, ZMAX, step });
}
function spread(frames: number[]): string {
  const f = [...frames].sort((a, b) => a - b), q = (p: number) => f[Math.min(f.length - 1, Math.floor(p * f.length))];
  return `${f.length} frames: median ${q(0.5).toFixed(1)} ms, 95th ${q(0.95).toFixed(1)}, 99th ${q(0.99).toFixed(1)}, worst ${f[f.length - 1].toFixed(1)}; over 25 ms: ${(100 * f.filter((x) => x > 25).length / f.length).toFixed(1)} %, over 50 ms: ${f.filter((x) => x > 50).length}`;
}

for (const [name, options] of ways) {
  test(`on the chip, ${name}: the site brings in the renderer by itself, and flies`, async ({ baseURL }, info) => {
    test.setTimeout(240_000);
    const { browser, why } = await launch(options, baseURL);
    test.skip(!browser, why);
    const context = await browser!.newContext({ baseURL, viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, reducedMotion: 'no-preference' });
    for (const [label, query] of [['SVG', '?original'], ['WebGL2', '?gpu=webgl2'], ['WebGPU', '?gpu=webgpu'], ['as the site chooses', '']] as const) {
      const page = await context.newPage();
      const running = await openRenderer(page, query);
      if (label === 'as the site chooses') expect(running, 'with a chip, the site takes the renderer by itself').not.toBeNull();
      // WebGPU is not in every browser that has a chip to draw with: there the site falls back to WebGL2
      if (label === 'WebGPU' && !running) { console.log(`  ${name}, WebGPU: not available in this browser`); await page.close(); continue; }
      if (label === 'WebGL2') expect(running, 'WebGL2 on a chip').not.toBeNull();
      await page.waitForTimeout(600);
      const result = await flight(page, 0.05);
      const line = `${name}, ${label}${running ? ` (${running.kind} on ${running.chip})` : ''}: ${spread(result.frames)}${running ? `; most marks in a frame ${result.marks}, most draws ${result.draws}` : ''}`;
      fs.appendFileSync(info.outputPath('flights.md'), line + '\n');
      console.log('  ' + line);
      await page.close();
    }
    await browser!.close();
  });
}

test('on the chip: the renderer next to the SVG as the chip draws it', async ({ baseURL }, info) => {
  test.setTimeout(240_000);
  const { browser, why } = await launch(onChip, baseURL);
  test.skip(!browser, why);
  for (const scale of [1, 2]) {
    const context = await browser!.newContext({ baseURL, viewport: { width: 1280, height: 820 }, deviceScaleFactor: scale, reducedMotion: 'reduce' });
    const svg = await context.newPage(), gpu = await context.newPage();
    await openSvg(svg);
    const running = await openRenderer(gpu, '?gpu=webgl2');
    expect(running, 'the renderer did not take over').not.toBeNull();
    const lines: string[] = [];
    for (const stop of LMS as { name: string; z: number }[]) {
      await Promise.all([setZoom(svg, stop.z), setZoom(gpu, stop.z)]);
      const a = PNG.sync.read(await svg.screenshot()), b = await rendered(gpu);
      // and the renderer as the page shows it, not as read back: the same thing, if the canvas reaches the screen untouched
      const m = measure(a, b, scale);
      lines.push(`| ${stop.name} | ${stop.z} | ${m.inkSvg.toFixed(0)} | ${(100 * (m.inkGpu / m.inkSvg - 1)).toFixed(1)} % | ${percent(m.over32, m.inked)} | ${percent(m.over64, m.inked)} | ${m.worst} | ${percent(m.soft.over16, m.inked)} | ${m.soft.worst.toFixed(0)} |`);
      if (stop.z === 0 || stop.z === 16.4) fs.writeFileSync(info.outputPath(`chip-${scale}x-z${stop.z}-svg.png`), PNG.sync.write(a));
    }
    const table = `${running!.kind} on ${running!.chip}, 1280 x 820 at ${scale}x, against the SVG drawn by the same chip\n| stop | zoom | ink (px) | ink vs SVG | > 32 levels | > 64 | worst | 3x3 avg > 16 | 3x3 worst |\n|---|---|---|---|---|---|---|---|---|\n` + lines.join('\n');
    fs.writeFileSync(info.outputPath(`table-${scale}x.md`), table + '\n');
    console.log('\n  ' + table.replace(/\n/g, '\n  '));
    await context.close();
  }
  await browser!.close();
});

test('on the chip: what reaches the screen is what the chip drew, with either backend', async ({ baseURL }) => {
  const { browser, why } = await launch(onChip, baseURL);
  test.skip(!browser, why);
  const context = await browser!.newContext({ baseURL, viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  for (const backend of ['webgl2', 'webgpu']) {
    const page = await context.newPage();
    const running = await openRenderer(page, '?gpu=' + backend);
    if (backend === 'webgpu' && !running) { console.log('  webgpu: not available in this browser'); await page.close(); continue; }
    expect(running, 'the renderer did not take over').not.toBeNull();
    expect(running!.kind).toBe(backend);
    await page.evaluate(() => window.__gpu!.handed);
    await page.addStyleTag({ content: '.hdr,.rail,.bl,.ink>canvas~svg{display:none !important}' });
    for (const z of [0, 13.2, -4.3]) {
      await setZoom(page, z);
      const drawn = await rendered(page);
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      const m = measure(PNG.sync.read(await page.screenshot()), drawn);
      console.log(`  ${running!.kind} on ${running!.chip}, zoom ${z}: the screen differs from what was drawn by at most ${m.worst} of 255 levels`);
      expect(m.worst).toBeLessThanOrEqual(1);
    }
    await page.close();
  }
  await browser!.close();
});

test('on the chip: before and after at every stop on the rail', async ({ baseURL }, info) => {
  test.setTimeout(240_000);
  const { browser, why } = await launch(onChip, baseURL);
  test.skip(!browser, why);
  const context = await browser!.newContext({ baseURL, viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const before = await context.newPage(), after = await context.newPage();
  await openRenderer(before, '?original');
  const running = await openRenderer(after, '');
  expect(running, 'the renderer did not take over').not.toBeNull();
  await after.evaluate(() => window.__gpu!.handed);
  for (const page of [before, after]) await page.evaluate(() => new Promise<void>((done) => { const check = () => (document.documentElement.classList.contains('fonts') ? done() : setTimeout(check, 10)); check(); }));
  const stops = LMS as { name: string; z: number }[];
  fs.mkdirSync(info.outputPath('shots'), { recursive: true });
  for (let i = 0; i < stops.length; i++) {
    const name = String(i + 1).padStart(2, '0') + '-' + stops[i].name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
    // each stop as the site shows it on arriving there: by its landmark on the rail
    for (const [page, which] of [[before, 'before'], [after, 'after']] as const) {
      await page.evaluate((index) => window.__perspective!.pick(index), i);
      if (which === 'after') await page.evaluate(() => window.__gpu!.settled());
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      await page.waitForTimeout(120);
      fs.writeFileSync(info.outputPath('shots', `${name}-${which}.png`), await page.screenshot());
    }
  }
  console.log(`  ${stops.length} stops photographed before (the SVG) and after (${running!.kind} on ${running!.chip}), 1280 x 820 at 2x: ${info.outputPath('shots')}`);
  await browser!.close();
});
