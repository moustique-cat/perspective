// Speed report for the built site, next to the original artboard run the original way.
//
//   npm run build && npm run bench
//
// 1. A scripted zoom from proton to edge, one fixed step per frame, timing every frame.
// 2. The first moments of loading on a throttled connection and processor.
//
// The numbers describe the machine they were taken on. A machine without a graphics chip
// (such as a CI runner) draws everything on the CPU; treat its figures as a floor.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4183, ORIGIN = `http://127.0.0.1:${PORT}`;
const ZMIN = -15, ZMAX = 27.9, STEP = 0.02;

const server = spawn(process.execPath, [path.join(root, 'e2e/serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ready, fail) => { server.stdout.once('data', ready); server.once('exit', (code) => fail(new Error('server exited ' + code))); });

const q = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const ms = (n) => n.toFixed(1).padStart(6);

async function journey(browser, label, url, setter, view) {
  const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, deviceScaleFactor: view.scale });
  const page = await context.newPage();
  await page.goto(ORIGIN + url);
  await page.evaluate(async () => {
    await Promise.all(["400 16px 'EB Garamond'", "italic 400 16px 'EB Garamond'", '400 13px Inter', '500 13px Inter', '600 13px Inter'].map((f) => document.fonts.load(f)));
    await document.fonts.ready;
  });
  await page.waitForTimeout(500);
  const cdp = await context.newCDPSession(page);
  let raster = 0;
  cdp.on('Tracing.dataCollected', (d) => { for (const e of d.value) if (e.ph === 'X' && e.name === 'RasterTask' && e.dur) raster += e.dur / 1000; });
  await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['disabled-by-default-devtools.timeline'] } });
  const r = await page.evaluate(({ setter, ZMIN, ZMAX, STEP }) => new Promise((resolve) => {
    const set = new Function('z', setter);
    const n = Math.round((ZMAX - ZMIN) / STEP);
    const frames = [], script = [], zs = [];
    let i = 0, last = 0;
    function frame(ts) {
      if (last) frames.push(ts - last);
      last = ts;
      if (i > n) { resolve({ frames, script, zs }); return; }
      const z = ZMIN + i * STEP;
      const t0 = performance.now();
      set(z);
      script.push(performance.now() - t0);
      zs.push(z);
      i++;
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }), { setter, ZMIN, ZMAX, STEP });
  const done = new Promise((res) => cdp.once('Tracing.tracingComplete', res));
  await cdp.send('Tracing.end');
  await done;
  await context.close();
  const f = [...r.frames].sort((a, b) => a - b), n = f.length;
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  // where the slow frames are, by power of ten
  const slow = new Map();
  r.frames.forEach((dt, i) => { if (dt > 25) { const k = Math.floor(r.zs[i]); slow.set(k, Math.max(slow.get(k) || 0, dt)); } });
  const where = [...slow.entries()].sort((a, b) => a[0] - b[0]).map(([k, worst]) => `10^${k} m (${worst.toFixed(0)} ms)`).join(', ') || 'none';
  console.log(`| ${label} | ${n} | ${ms(q(f, 0.5))} | ${ms(q(f, 0.95))} | ${ms(q(f, 0.99))} | ${ms(f[n - 1])} | ${(100 * f.filter((x) => x > 17.5).length / n).toFixed(1)} % | ${mean(r.script).toFixed(2)} | ${(raster / n).toFixed(1)} | ${where} |`);
}

async function loading(browser, label, net) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: net.latency, downloadThroughput: net.down * 1024 / 8, uploadThroughput: net.up * 1024 / 8 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: net.cpu });
  await page.addInitScript(() => {
    window.__marks = {};
    new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.name === 'first-contentful-paint') window.__marks.paint = e.startTime; }).observe({ type: 'paint', buffered: true });
    const poll = () => {
      const m = window.__marks;
      if (m.zoomable === undefined && window.__perspective) m.zoomable = performance.now();
      if (m.words === undefined && document.documentElement.classList.contains('fonts')) m.words = performance.now();
      const layers = document.querySelectorAll('[data-layer]');
      if (m.complete === undefined && layers.length && Array.from(layers).every((g) => g.childElementCount > 0)) m.complete = performance.now();
      if (m.complete === undefined || m.words === undefined) requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
  await page.goto(ORIGIN + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__marks.complete !== undefined && window.__marks.words !== undefined, null, { timeout: 120000 });
  const m = await page.evaluate(() => window.__marks);
  await context.close();
  const s = (v) => (v / 1000).toFixed(2).padStart(5) + ' s';
  console.log(`| ${label} | ${s(m.paint)} | ${s(m.zoomable)} | ${s(m.words)} | ${s(m.complete)} |`);
}

const browser = await chromium.launch();
console.log(`Scripted zoom: ${Math.round((ZMAX - ZMIN) / STEP)} frames from 10^${ZMIN} m to 10^${ZMAX} m, ${STEP} decades per frame. Times in ms; the display refreshes every 16.7 ms.\n`);
console.log('| page, window | frames | median | 95th | 99th | worst | over one refresh | script per frame | raster per frame | frames over 25 ms are at |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const view of [{ width: 1280, height: 820, scale: 1 }, { width: 1920, height: 820, scale: 2 }]) {
  const name = `${view.width} x ${view.height} at ${view.scale}x`;
  await journey(browser, `original, ${name}`, '/__reference/', 'window.__ref.setZ(z)', view);
  await journey(browser, `site, ${name}`, '/', 'window.__perspective.setZ(z)', view);
}
console.log('\nFirst load on a phone-sized window (390 x 844 at 3x), empty cache. Seconds from the start of navigation.\n');
console.log('| connection | drawing visible | zoomable | words visible | every layer in place |');
console.log('|---|---|---|---|---|');
await loading(browser, 'unthrottled', { latency: 0, down: 1e6, up: 1e6, cpu: 1 });
await loading(browser, 'fast 4G (9 Mbit/s, 60 ms), CPU 4x slower', { latency: 60, down: 9000, up: 9000, cpu: 4 });
await loading(browser, 'slow 4G (1.6 Mbit/s, 150 ms), CPU 4x slower', { latency: 150, down: 1600, up: 750, cpu: 4 });
await loading(browser, 'slow 3G (400 kbit/s, 400 ms), CPU 6x slower', { latency: 400, down: 400, up: 400, cpu: 6 });
await browser.close();
server.kill();
