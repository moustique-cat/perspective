// The renderer against the SVG, on identical content.
//
// Two pages of the built site in the same browser: one keeps the SVG (?original) and shows
// only the part of the drawing the renderer replaces; the other runs the renderer, whose
// picture is read back from the chip. Software rendering, so the pictures are the same on
// every machine. (How it does on a real chip is e2e/chip.spec.ts.)
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { LMS } from '../src/generated/core.js';
import { measure, openRenderer, openSvg, percent, rendered, setZoom } from './gpu';

const stops: { name: string; z: number }[] = LMS.map((l: { name: string; z: number }) => ({ name: l.name, z: l.z }));
const windows = [
  { name: '1280 x 820 at 1x', width: 1280, height: 820, scale: 1 },
  { name: '1280 x 820 at 2x', width: 1280, height: 820, scale: 2 },
  { name: 'a phone, 390 x 820 at 3x', width: 390, height: 820, scale: 3 },
];

for (const backend of ['webgl2']) {
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
      const lines: string[] = [];
      for (const stop of stops) {
        await Promise.all([setZoom(svg, stop.z), setZoom(gpu, stop.z)]);
        const a = (await import('pngjs')).PNG.sync.read(await svg.screenshot()), b = await rendered(gpu);
        const m = measure(a, b);
        const stats = await gpu.evaluate(() => window.__gpu!.stats);
        lines.push(`| ${stop.name} | ${stop.z} | ${m.inkSvg.toFixed(0)} | ${(100 * (m.inkGpu / m.inkSvg - 1)).toFixed(1)} % | ${percent(m.over32, m.inked)} | ${percent(m.over64, m.inked)} | ${m.worst} | ${percent(m.soft.over16, m.inked)} | ${m.soft.worst.toFixed(0)} | ${stats.marks} | ${stats.calls} |`);
        if (m.over128 || m.soft.over32) fs.writeFileSync(info.outputPath(`${w.scale}x-z${stop.z}-difference.png`), m.picture());
      }
      console.log(`\n  ${backend}, ${w.name}\n  | stop | zoom | ink (px) | ink vs SVG | > 32 levels | > 64 | worst | 3x3 avg > 16 | 3x3 worst | marks | draws |\n  |---|---|---|---|---|---|---|---|---|---|---|\n  ` + lines.join('\n  '));
      expect(problems).toEqual([]);
      await context.close();
    });
  }
}
