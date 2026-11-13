// The site as a page of its own: what it loads, how it starts, how it responds, how it fits
// other window sizes. (Whether it matches the design is e2e/original.spec.ts.)
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { LMS, ZMAX } from '../src/generated/core.js';
import { computeFrame, MIN_RAIL_H, MIN_RAIL_W, type Props } from '../src/frame';
import { props as designProps } from '../src/generated/page.js';
import { openSite, pixelDelta, sameInk, settled } from './compare';

const html = fs.readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const firstPaintEnd = html.indexOf('</script>', html.indexOf('<script id="first-paint">')) + 9;
const scriptEnd = html.indexOf('</script>', html.indexOf('<script>', firstPaintEnd)) + 9;
const gz = (s: string) => gzipSync(Buffer.from(s), { level: 9 }).length;

const zoom = (page: Page) => page.evaluate(() => window.__perspective!.z);
/** Wait for the zoom to stop moving and return where it stopped. */
async function atRest(page: Page): Promise<number> {
  let last = NaN;
  for (let i = 0; i < 400; i++) {
    const z = await zoom(page);
    if (z === last) return z;
    last = z;
    await page.waitForTimeout(40);
  }
  throw new Error('the zoom never came to rest');
}
/** A flight stops within 0.0006 decades of its target: that is the design's own rest threshold. */
const REST = 0.00061;
const expectAt = (z: number, target: number) => expect(Math.abs(z - target), `zoom ${z}, expected ${target}`).toBeLessThanOrEqual(REST);

test.describe('loading', () => {
  test('everything comes from the site itself: one page and its fonts', async ({ page }) => {
    const requests: string[] = [], problems: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    page.on('requestfailed', (r) => problems.push('failed: ' + r.url()));
    page.on('pageerror', (e) => problems.push('error: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.type() + ': ' + m.text()); });
    await openSite(page);
    await page.waitForTimeout(500);
    const origin = new URL(page.url()).origin;
    expect(requests.filter((u) => !u.startsWith(origin) && !u.startsWith('data:'))).toEqual([]);
    // the page, the two fonts its words need, and (once idle) the italic used only for the quark labels
    expect(requests.map((u) => new URL(u).pathname).sort()).toEqual([
      '/', '/fonts/eb-garamond-v33-italic-latin.woff2', '/fonts/eb-garamond-v33-latin.woff2', '/fonts/inter-v20-latin.woff2',
    ]);
    expect(problems).toEqual([]);
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org\/)/);
  });

  test('all 33 layers of the drawing are in place, in the design\'s order', async ({ page }) => {
    await openSite(page);
    const layers = await page.evaluate(() => Array.from(document.querySelectorAll('[data-layer]')).map((g) => [g.getAttribute('data-layer'), g.childElementCount] as const));
    expect(layers).toHaveLength(33);
    for (const [name, children] of layers) expect(children, `layer ${name} is empty`).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.querySelectorAll('template').length)).toBe(0);
  });

  test('stays within its size budget', () => {
    const sizes = { firstView: gz(html.slice(0, firstPaintEnd)), interactive: gz(html.slice(0, scriptEnd)), whole: gz(html) };
    console.log(`  compressed: first view ${sizes.firstView} B, zoomable ${sizes.interactive} B, whole page ${sizes.whole} B`);
    // one TCP round trip carries about 14 kB: the first view has to fit in it
    expect(sizes.firstView).toBeLessThanOrEqual(13_500);
    expect(sizes.interactive).toBeLessThanOrEqual(28_000);
    expect(sizes.whole).toBeLessThanOrEqual(160_000);
  });

  for (const size of [{ width: 1280, height: 820 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`the first ${Math.round(firstPaintEnd / 1024)} kB alone draw Moustique exactly, at ${size.width} x ${size.height}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: size, reducedMotion: 'reduce' });
      // the whole page, with its words hidden: this is the drawing the first part must produce
      const whole = await context.newPage();
      await openSite(whole);
      await whole.addStyleTag({ content: '.hdr,.rail,.bl{opacity:0 !important}' });
      await settled(whole);
      const expected = await whole.screenshot();
      // only the beginning of the page: no main script, no fonts, no late layers
      const partial = await context.newPage();
      await partial.route('**/*', (route) => (new URL(route.request().url()).pathname === '/' ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html.slice(0, firstPaintEnd) }) : route.abort()));
      await partial.goto('/');
      await settled(partial);
      expect(await partial.evaluate(() => typeof window.__perspective)).toBe('undefined');
      const delta = pixelDelta(await partial.screenshot(), expected);
      expect(delta.differing === 0 || sameInk(delta), `${delta.differing} px differ`).toBe(true);
      await context.close();
    });
  }

  test('on a slow connection: the drawing first, then zooming, then the rest, with no blank moment', async ({ page }) => {
    const started = Date.now();
    await page.goto('/?drip=500', { waitUntil: 'commit' });
    // 1. first part only: Moustique is on screen, nothing can be zoomed yet
    await page.waitForFunction(() => document.documentElement.classList.contains('ready'));
    const shownAfter = Date.now() - started;
    expect(await page.evaluate(() => typeof window.__perspective)).toBe('undefined');
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.ink')!).visibility)).toBe('visible');
    const picture = await page.screenshot({ clip: { x: 200, y: 150, width: 640, height: 400 } });
    expect(pixelDelta(picture, picture).differing).toBe(0);
    const inked = await page.evaluate(() => document.querySelector('[data-layer="cat"]')!.getBoundingClientRect().width);
    expect(inked).toBeGreaterThan(300);
    // 2. the main script arrives: zooming works although most layers have not arrived
    await page.waitForFunction(() => !!window.__perspective);
    const missing = await page.evaluate(() => Array.from(document.querySelectorAll('[data-layer]')).filter((g) => g.childElementCount === 0).length);
    expect(missing).toBe(28);
    await page.mouse.move(400, 300);
    await page.mouse.wheel(0, 100);
    expectAt(await atRest(page), 0.22);
    // 3. the rest arrives and slots in
    await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-layer]')).every((g) => g.childElementCount > 0));
    console.log(`  drawing visible ${shownAfter} ms after navigation started (the server held the rest back for 1000 ms)`);
    expect(shownAfter).toBeLessThan(450);
  });

  test('a layer that arrives after the zoom has reached it is inked in, not popped in', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, reducedMotion: 'no-preference' });
    const page = await context.newPage();
    await openSite(page);
    await page.evaluate(() => window.__perspective!.setZ(1.5));
    const result = await page.evaluate(() => {
      // send the house back to where late layers come from, then let it arrive again
      const g = document.querySelector('[data-layer="house"]')!;
      const before = g.childElementCount;
      const tpl = document.createElement('template');
      tpl.setAttribute('data-for', 'house');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.append(...Array.from(g.childNodes));
      tpl.content.appendChild(svg);
      document.body.appendChild(tpl);
      const empty = g.childElementCount;
      const script = document.createElement('script');
      script.textContent = 'window.__L&&__L()';
      document.body.appendChild(script);
      return { before, empty, after: g.childElementCount, fading: g.getAnimations().length, templates: document.querySelectorAll('template').length };
    });
    expect(result.empty).toBe(0);
    expect(result.after).toBe(result.before);
    expect(result.fading).toBe(1);
    expect(result.templates).toBe(0);
    await context.close();
  });
});

test.describe('responding', () => {
  test('the wheel zooms, and the browser is kept from zooming or swiping the page itself', async ({ page }) => {
    await openSite(page);
    await page.mouse.move(500, 400);
    await page.mouse.wheel(0, 500);
    expectAt(await atRest(page), 1.1);
    await page.mouse.wheel(0, -1000);
    expectAt(await atRest(page), -1.1);
    // over the rail too, as in the design
    await page.mouse.move(1150, 600);
    await page.mouse.wheel(0, 500);
    expectAt(await atRest(page), 0);
    const prevented = await page.evaluate(() => ['.stage', '.rail', '.lm', '.btn'].map((sel) => {
      const e = new WheelEvent('wheel', { deltaY: 4, ctrlKey: true, bubbles: true, cancelable: true });
      document.querySelector(sel)!.dispatchEvent(e);
      return e.defaultPrevented;
    }));
    expect(prevented).toEqual([true, true, true, true]);
    // a pinch (ctrl + wheel) zooms faster per unit, as in the design: 4 x 4 events x 0.012
    expectAt(await atRest(page), 0.192);
  });

  test('Fly out flies and pauses; Back to Moustique returns', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, reducedMotion: 'no-preference' });
    const page = await context.newPage();
    await openSite(page);
    await page.getByRole('button', { name: 'Fly out' }).click();
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
    await page.waitForTimeout(700);
    const a = await zoom(page);
    await page.waitForTimeout(300);
    const b = await zoom(page);
    // it leaves Moustique slowly: the design dwells at every stop
    expect(a).toBeGreaterThan(0.03);
    expect(a).toBeLessThan(0.6);
    expect(b).toBeGreaterThan(a);
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByRole('button', { name: 'Fly out' })).toBeVisible();
    const paused = await atRest(page);
    await page.getByRole('button', { name: 'Back to Moustique' }).click();
    const home = await atRest(page);
    expect(paused).toBeGreaterThan(b - 0.01);
    expectAt(home, 0);
    await context.close();
  });

  test('every landmark on the rail goes to its place and shows its caption', async ({ page }) => {
    await openSite(page);
    for (const [i, landmark] of (LMS as { name: string; z: number }[]).entries()) {
      await page.locator('.lm').nth(i).click();
      expect(await zoom(page), landmark.name).toBe(landmark.z);
      await expect(page.locator('.cap[aria-hidden="false"] h2')).toHaveText(landmark.name);
      await expect(page.locator('.lm[aria-current="true"]')).toHaveText(landmark.name);
    }
    await expect(page.locator('[aria-live="polite"]')).toContainText('A proton. Three quarks');
  });

  test('the rail works from the keyboard', async ({ page }) => {
    await openSite(page);
    const rail = page.locator('.rail-rng');
    await rail.focus();
    await page.keyboard.press('ArrowUp');
    expectAt(await atRest(page), 0.25);
    await page.keyboard.press('Shift+PageDown');
    expectAt(await atRest(page), -3.75);
    await page.keyboard.press('End');
    expect(await zoom(page)).toBe(ZMAX);
    await expect(rail).toHaveAttribute('aria-valuetext', /light-years across, The observable universe$/);
  });

  test('touch: one finger drags the zoom, two fingers pinch it', async ({ page }) => {
    await openSite(page);
    const touch = (type: string, id: number, x: number, y: number) => page.evaluate(([t, i, px, py]) => {
      document.querySelector('.stage')!.dispatchEvent(new PointerEvent(t as string, { pointerType: 'touch', pointerId: i as number, clientX: px as number, clientY: py as number, bubbles: true, cancelable: true }));
    }, [type, id, x, y]);
    await touch('pointerdown', 1, 300, 500);
    await touch('pointermove', 1, 300, 400);
    await touch('pointerup', 1, 300, 400);
    expectAt(await atRest(page), 0.6);
    await touch('pointerdown', 1, 300, 400);
    await touch('pointerdown', 2, 400, 400);
    await touch('pointermove', 2, 1300, 400);
    await touch('pointerup', 1, 300, 400);
    await touch('pointerup', 2, 1300, 400);
    expectAt(await atRest(page), -0.4);
  });
});

test.describe('fitting the window', () => {
  const sizes = [
    { width: 1280, height: 820 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 2560, height: 1440 },
    { width: 1024, height: 600 }, { width: MIN_RAIL_W, height: MIN_RAIL_H }, { width: 1024, height: 1366 },
    { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 759, height: 900 }, { width: 900, height: 559 },
  ];
  for (const size of sizes) {
    test(`${size.width} x ${size.height}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: size, reducedMotion: 'reduce' });
      const page = await context.newPage();
      const problems: string[] = [];
      page.on('pageerror', (e) => problems.push(e.message));
      await openSite(page);
      const desk = size.width >= MIN_RAIL_W && size.height >= MIN_RAIL_H;
      for (const z of [0, 9.1, -4.3]) {
        await page.evaluate((zz) => window.__perspective!.setZ(zz), z);
        const got = await page.evaluate(() => {
          const ink = document.querySelector('.ink')!.getBoundingClientRect();
          const rail = document.querySelector<HTMLElement>('.rail')!;
          const buttons = Array.from(document.querySelectorAll('.lm')).map((b) => b.getBoundingClientRect());
          const track = document.querySelector('.rail .tr')!.getBoundingClientRect();
          const needle = document.querySelector('.rail svg g')!.getBoundingClientRect();
          return {
            ink: [ink.width, ink.height],
            scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
            rail: getComputedStyle(rail).display !== 'none',
            viewBox: document.querySelector('.ink > svg')!.getAttribute('viewBox'),
            gaps: buttons.slice(1).map((b, i) => b.top - buttons[i].bottom),
            first: buttons[0].top, last: buttons[buttons.length - 1].bottom,
            track: [track.top, track.bottom], needle: (needle.top + needle.bottom) / 2,
          };
        });
        expect(got.ink).toEqual([size.width, size.height]);
        expect(got.scroll).toEqual([size.width, size.height]);
        expect(got.rail).toBe(desk);
        const frame = computeFrame({ z, playing: 0, vw: size.width, vh: size.height, jump: null, announce: '', coarse: false, props: designProps as Props }, { a: { key: '', t: '', d: '' }, b: { key: '', t: '', d: '' }, on: 'a' });
        expect(got.viewBox).toBe(frame.vb);
        if (desk) {
          expect(Math.min(...got.gaps), 'landmark labels overlap').toBeGreaterThanOrEqual(-0.2);
          expect(got.first).toBeGreaterThanOrEqual(0);
          expect(got.last).toBeLessThanOrEqual(size.height);
          expect(got.track[0]).toBeCloseTo(48, 0);
          expect(got.track[1]).toBeCloseTo(size.height - 24, 0);
          expect(got.needle).toBeGreaterThanOrEqual(got.track[0] - 1);
          expect(got.needle).toBeLessThanOrEqual(got.track[1] + 1);
        }
      }
      expect(problems).toEqual([]);
      await context.close();
    });
  }
});
