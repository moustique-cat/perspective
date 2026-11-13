// The built site against the original artboard.
//
// Both run in the same browser at the same window size. The reference page is the unedited
// design file with a minimal stand-in for the design tool's runtime (e2e/reference). At the
// artboard's height of 820 px the site must have exactly the original's structure, styles and
// positions, and bit for bit the same picture (see e2e/compare.ts).
import { expect, test } from '@playwright/test';
import { GAPS, LMS, PRE, ZMAX, ZMIN } from '../src/generated/core.js';
import { compareAcross, openReference, openSite, pixelDelta, plainPage, repaint, summary } from './compare';

const landmarks: number[] = LMS.map((l: { z: number }) => l.z);
const captions: number[] = [...GAPS, ...PRE].map((g: (number | string)[]) => (Math.min(g[1] as number, ZMAX) + (g[0] as number)) / 2);
function sweep(step: number): number[] {
  const zs = new Set<number>([ZMIN, ZMAX, ...landmarks, ...captions]);
  for (let z = Math.ceil(ZMIN / step) * step; z <= ZMAX; z += step) zs.add(Number(z.toFixed(3)));
  return [...zs].sort((a, b) => a - b);
}

const windows = [
  { name: 'the artboard size, 1280 x 820', width: 1280, height: 820, scale: 1, zooms: sweep(0.2) },
  { name: 'the artboard size on a 2x display', width: 1280, height: 820, scale: 2, zooms: sweep(1) },
  { name: 'a wide window, 1920 x 820', width: 1920, height: 820, scale: 1, zooms: sweep(0.5) },
  { name: 'just below the rail breakpoint, 759 x 820', width: 759, height: 820, scale: 1, zooms: sweep(1) },
  { name: 'a phone-width window on a 3x display, 390 x 820', width: 390, height: 820, scale: 3, zooms: sweep(1) },
];

for (const w of windows) {
  test(`same as the original at ${w.name} (${w.zooms.length} zooms)`, async ({ browser }, info) => {
    const context = await browser.newContext({ viewport: { width: w.width, height: w.height }, deviceScaleFactor: w.scale, reducedMotion: 'reduce' });
    const reference = await context.newPage(), site = await context.newPage();
    await openReference(reference);
    await openSite(site);
    const result = await compareAcross(reference, site, w.zooms, info);
    console.log(`  ${w.name}: ${summary(result)}`);
    info.annotations.push({ type: 'result', description: summary(result) });
    expect(result.structure, 'page structure, styles or positions differ').toEqual([]);
    expect(result.pixels, 'the pictures differ').toEqual([]);
    await context.close();
  });
}

const tweaks = [
  { name: 'blue ink', site: '?ink=26304A', props: { ink: '#26304A' } },
  { name: 'brown ink, hand-drawn line', site: '?ink=3B2F27&hand=1', props: { ink: '#3B2F27', handDrawn: true } },
  { name: 'a 60 cm Moustique', site: '?cm=60', props: { moustiqueLengthCm: 60 } },
];
for (const t of tweaks) {
  test(`same as the original with ${t.name}`, async ({ browser }, info) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, reducedMotion: 'reduce' });
    const reference = await context.newPage(), site = await context.newPage();
    await openReference(reference, '?props=' + encodeURIComponent(JSON.stringify(t.props)));
    await openSite(site, t.site);
    const result = await compareAcross(reference, site, [...landmarks, -0.4, 0.6, 5.5], info);
    console.log(`  ${t.name}: ${summary(result)}`);
    info.annotations.push({ type: 'result', description: summary(result) });
    expect(result.structure, 'page structure, styles or positions differ').toEqual([]);
    expect(result.pixels, 'the pictures differ').toEqual([]);
    await context.close();
  });
}

test('same picture as the original with scripts switched off (the page as first delivered)', async ({ browser }) => {
  const withJs = await browser.newContext({ viewport: { width: 1280, height: 820 }, reducedMotion: 'reduce' });
  const reference = await withJs.newPage();
  await openReference(reference);
  // The original, photographed as it happens to have loaded, is not always the same picture:
  // in 6 of 36 loads measured, some 30 pixels along a line of its words were one level off
  // (probably a trace of the fallback font they were first drawn in; the cause was not pinned
  // down). Redrawn, it always is. The scripts-off page was the same picture in all 36, and it
  // could not run the redraw anyway.
  await repaint(reference);
  const expected = await reference.screenshot();
  const noJs = await browser.newContext({ viewport: { width: 1280, height: 820 }, javaScriptEnabled: false });
  const site = await noJs.newPage();
  await site.goto('/', { waitUntil: 'networkidle' });
  const got = await site.screenshot();
  const delta = pixelDelta(got, expected);
  expect(delta.differing, `the static page differs from the original at the home zoom, by up to ${delta.worst} levels`).toBe(0);
  await plainPage(reference, 'the reference page');
  await withJs.close();
  await noJs.close();
});
