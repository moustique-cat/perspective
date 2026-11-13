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

async function launch(options: LaunchOptions): Promise<Browser | null> {
  try { return await chromium.launch({ timeout: 30_000, ...options }); } catch { return null; }
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
  return `${f.length} frames: median ${q(0.5).toFixed(1)} ms, 95th ${q(0.95).toFixed(1)}, 99th ${q(0.99).toFixed(1)}, worst ${f[f.length - 1].toFixed(1)}; over 17.5 ms: ${(100 * f.filter((x) => x > 17.5).length / f.length).toFixed(1)} %, over 50 ms: ${f.filter((x) => x > 50).length}`;
}

for (const [name, options] of ways) {
  test(`on the chip, ${name}: the site brings in the renderer by itself, and flies`, async ({ baseURL }) => {
    test.setTimeout(240_000);
    const browser = await launch(options);
    test.skip(!browser, 'this way of launching is not available here');
    const context = await browser!.newContext({ baseURL, viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, reducedMotion: 'no-preference' });
    for (const [label, query] of [['SVG', '?original'], ['WebGL2', '?gpu=webgl2'], ['as the site chooses', '']] as const) {
      const page = await context.newPage();
      const running = await openRenderer(page, query);
      if (label === 'as the site chooses') {
        const drawsWith = await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'); const e = gl && gl.getExtension('WEBGL_debug_renderer_info'); return gl && e ? String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : 'none'; });
        if (/swiftshader|llvmpipe|software/i.test(drawsWith)) { await browser!.close(); test.skip(true, 'no graphics chip here: ' + drawsWith); }
        expect(running, 'with a chip, the site takes the renderer by itself').not.toBeNull();
      }
      await page.waitForTimeout(600);
      const result = await flight(page, 0.05);
      console.log(`  ${name}, ${label}${running ? ` (${running.kind} on ${running.chip})` : ''}: ${spread(result.frames)}${running ? `; most marks in a frame ${result.marks}, most draws ${result.draws}` : ''}`);
      await page.close();
    }
    await browser!.close();
  });
}

test('on the chip: the renderer next to the SVG as the chip draws it', async ({ baseURL }, info) => {
  test.setTimeout(240_000);
  const browser = await launch(onChip);
  test.skip(!browser, 'this way of launching is not available here');
  for (const scale of [1, 2]) {
    const context = await browser!.newContext({ baseURL, viewport: { width: 1280, height: 820 }, deviceScaleFactor: scale, reducedMotion: 'reduce' });
    const svg = await context.newPage(), gpu = await context.newPage();
    await openSvg(svg);
    const running = await openRenderer(gpu, '?gpu=webgl2');
    if (!running || /swiftshader|llvmpipe|software/i.test(running.chip)) { await browser!.close(); test.skip(true, 'no graphics chip here'); }
    const lines: string[] = [];
    for (const stop of LMS as { name: string; z: number }[]) {
      await Promise.all([setZoom(svg, stop.z), setZoom(gpu, stop.z)]);
      const a = PNG.sync.read(await svg.screenshot()), b = await rendered(gpu);
      // and the renderer as the page shows it, not as read back: the same thing, if the canvas reaches the screen untouched
      const m = measure(a, b);
      lines.push(`| ${stop.name} | ${stop.z} | ${m.inkSvg.toFixed(0)} | ${(100 * (m.inkGpu / m.inkSvg - 1)).toFixed(1)} % | ${percent(m.over32, m.inked)} | ${percent(m.over64, m.inked)} | ${m.worst} | ${percent(m.soft.over16, m.inked)} | ${m.soft.worst.toFixed(0)} |`);
      if (stop.z === 0 || stop.z === 16.4) fs.writeFileSync(info.outputPath(`chip-${scale}x-z${stop.z}-svg.png`), PNG.sync.write(a));
    }
    console.log(`\n  ${running!.kind} on ${running!.chip}, 1280 x 820 at ${scale}x, against the SVG drawn by the same chip\n  | stop | zoom | ink (px) | ink vs SVG | > 32 levels | > 64 | worst | 3x3 avg > 16 | 3x3 worst |\n  |---|---|---|---|---|---|---|---|---|\n  ` + lines.join('\n  '));
    await context.close();
  }
  await browser!.close();
});
