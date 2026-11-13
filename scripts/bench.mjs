// Speed report for the built site.
//
//   npm run build && npm run bench            (add "-- --window" to fly in a real window)
//
// 1. A scripted zoom from proton to edge, one fixed step per frame, timing every frame:
//    the original artboard and the site's SVG drawn in software (the figures of milestone 1,
//    and all a machine without a graphics chip can say), then, where this machine has a chip,
//    the SVG and both renderers drawn by it.
// 2. The first moments of loading on a throttled connection and processor.
//
// The numbers describe the machine they were taken on. Software figures are a floor and a
// regression check, nothing more: the renderer exists for graphics chips. On a device of
// your own, open the site with ?bench instead: the same flight, measured by the page itself.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// a port of its own each time: a run that was cut short may still hold the last one
const PORT = 4200 + Math.floor(Math.random() * 700), ORIGIN = `http://127.0.0.1:${PORT}`;
const ZMIN = -15, ZMAX = 27.9, STEP = 0.02;
const inWindow = process.argv.includes('--window');
// --software or --chip: only that half of the report
const only = process.argv.includes('--software') ? 'software' : process.argv.includes('--chip') ? 'chip' : '';
/** A flight that has not finished after this long is cut short and reported as far as it got. */
const PATIENCE = 150_000;
// --check: fail if what can be judged without a graphics chip has got worse: what the page's own
// script costs per frame, and that a chipless machine is left with its SVG. Limits in ms per frame,
// several times what a CI machine measures.
const check = process.argv.includes('--check');
const LIMITS = { svg: 2, renderer: 5 };
const failures = [];

const server = spawn(process.execPath, [path.join(root, 'e2e/serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ready, fail) => { server.stdout.once('data', ready); server.once('exit', (code) => fail(new Error('server exited ' + code))); });

const q = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const ms = (n) => n.toFixed(1).padStart(6);

/** Opens a page and waits until it is settled what draws it. */
async function open(context, url) {
  const page = await context.newPage();
  await page.goto(ORIGIN + url);
  await page.evaluate(async () => {
    await Promise.all(["400 16px 'EB Garamond'", "italic 400 16px 'EB Garamond'", '400 13px Inter', '500 13px Inter', '600 13px Inter'].map((f) => document.fonts.load(f)));
    await document.fonts.ready;
  });
  // the site says when it has decided between the renderer and the SVG; the original artboard has no such thing
  const drawnBy = await page.evaluate(async () => {
    if (!('__perspective' in window)) return 'SVG';
    while (window.__gpu === undefined) await new Promise((r) => setTimeout(r, 50));
    if (!window.__gpu) return 'SVG';
    await window.__gpu.handed;
    await window.__gpu.idle();
    return window.__gpu.kind;
  });
  await page.waitForTimeout(500);
  return { page, drawnBy };
}

async function journey(browser, label, url, setter, view) {
  const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, deviceScaleFactor: view.scale });
  const { page, drawnBy } = await open(context, url);
  const said = [];
  page.on('console', (m) => { if (/^Perspective:/.test(m.text())) said.push(m.text()); });
  // the flight runs in the page and keeps its own record, so that one that crawls can be cut short and still reported
  await page.evaluate(({ setter, ZMIN, ZMAX, STEP }) => {
    const set = new Function('z', setter);
    const n = Math.round((ZMAX - ZMIN) / STEP);
    const flight = window.__flight = { frames: [], script: [], zs: [], marks: 0, draws: 0, done: false };
    let i = 0, last = 0;
    function frame(ts) {
      if (last) flight.frames.push(ts - last);
      last = ts;
      if (window.__gpu) { flight.marks = Math.max(flight.marks, window.__gpu.stats.marks); flight.draws = Math.max(flight.draws, window.__gpu.stats.calls); }
      if (i > n) { flight.done = true; return; }
      const z = ZMIN + i * STEP;
      const t0 = performance.now();
      set(z);
      flight.script.push(performance.now() - t0);
      flight.zs.push(z);
      i++;
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }, { setter, ZMIN, ZMAX, STEP });
  const started = Date.now();
  while (!(await page.evaluate(() => window.__flight.done)) && Date.now() - started < PATIENCE) await new Promise((r) => setTimeout(r, 500));
  const r = await page.evaluate(() => window.__flight);
  const endedBy = await page.evaluate(() => (window.__gpu ? window.__gpu.kind : 'SVG')).catch(() => '?');
  await context.close();
  const f = [...r.frames].sort((a, b) => a - b), n = f.length;
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  // where the slow frames are, by power of ten
  const slow = new Map();
  r.frames.forEach((dt, i) => { if (dt > 25) { const k = Math.floor(r.zs[i]); slow.set(k, Math.max(slow.get(k) || 0, dt)); } });
  const where = [...slow.entries()].sort((a, b) => a[0] - b[0]).map(([k, worst]) => `10^${k} m (${worst.toFixed(0)} ms)`).join(', ') || 'none';
  const notes = [];
  if (!r.done) notes.push(`cut short after ${Math.round(PATIENCE / 1000)} s, at 10^${r.zs[r.zs.length - 1].toFixed(1)} m`);
  if (endedBy !== drawnBy) notes.push(`ended drawn by ${endedBy}`);
  for (const line of said) notes.push(line);
  console.log(`| ${label} | ${drawnBy} | ${n} | ${ms(q(f, 0.5))} | ${ms(q(f, 0.95))} | ${ms(q(f, 0.99))} | ${ms(f[n - 1])} | ${(100 * f.filter((x) => x > 25).length / n).toFixed(1)} % | ${f.filter((x) => x > 50).length} | ${mean(r.script).toFixed(2)} | ${r.marks || ''} | ${r.draws || ''} | ${where}${notes.length ? ' [' + notes.join('; ') + ']' : ''} |`);
  return { drawnBy, script: mean(r.script) };
}

async function loading(browser, label, net, url = '/') {
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
      // the renderer, if this device gets one: when its picture is the one on screen
      if (m.renderer === undefined && window.__gpu !== undefined) {
        // null: this device stays with the SVG; 0: the renderer is on its way
        m.renderer = window.__gpu ? 0 : null;
        if (window.__gpu) window.__gpu.handed.then(() => { m.renderer = performance.now(); });
      }
      if (m.complete === undefined || m.words === undefined || !(m.renderer === null || m.renderer > 0)) requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
  await page.goto(ORIGIN + url, { waitUntil: 'load' });
  // the paint entry is reported a moment after the paint itself: on a fast load, wait for it too
  await page.waitForFunction(() => window.__marks.complete !== undefined && window.__marks.words !== undefined && window.__marks.paint !== undefined && (window.__marks.renderer === null || window.__marks.renderer > 0), null, { timeout: 120000 });
  const m = await page.evaluate(() => window.__marks);
  await context.close();
  const s = (v) => (v ? (v / 1000).toFixed(2).padStart(5) + ' s' : 'stays SVG');
  console.log(`| ${label} | ${s(m.paint)} | ${s(m.zoomable)} | ${s(m.words)} | ${s(m.complete)} | ${s(m.renderer)} |`);
}

const NETWORKS = [
  ['unthrottled', { latency: 0, down: 1e6, up: 1e6, cpu: 1 }],
  ['fast 4G (9 Mbit/s, 60 ms), CPU 4x slower', { latency: 60, down: 9000, up: 9000, cpu: 4 }],
  ['slow 4G (1.6 Mbit/s, 150 ms), CPU 4x slower', { latency: 150, down: 1600, up: 750, cpu: 4 }],
  ['slow 3G (400 kbit/s, 400 ms), CPU 6x slower', { latency: 400, down: 400, up: 400, cpu: 6 }],
];
const FLIGHT_HEAD = '| page, window | drawn by | frames | median | 95th | 99th | worst | over 25 ms | over 50 ms | script per frame | most marks | most draws | frames over 25 ms are at |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|';
const LOADING_HEAD = '| connection | drawing visible | zoomable | words visible | every layer in place | renderer on screen |\n|---|---|---|---|---|---|';

console.log(`Machine: ${os.cpus()[0].model}, ${os.cpus().length} cores, ${os.platform()} ${os.release()}, Node.js ${process.version}.`);
console.log(`Scripted zoom: ${Math.round((ZMAX - ZMIN) / STEP)} frames from 10^${ZMIN} m to 10^${ZMAX} m, ${STEP} decades per frame. Times in ms; a 60 Hz display refreshes every 16.7 ms.\n`);

// ---- in software: what milestone 1 measured, and the renderer forced onto the processor as a regression check
if (only !== 'chip') {
const software = await chromium.launch({ args: ['--use-angle=swiftshader-webgl'] });
console.log('In software (no graphics chip used). The site by itself stays with its SVG here.\n');
console.log(FLIGHT_HEAD);
for (const view of [{ width: 1280, height: 820, scale: 1 }, { width: 1920, height: 820, scale: 2 }]) {
  const name = `${view.width} x ${view.height} at ${view.scale}x`;
  await journey(software, `original, ${name}`, '/__reference/', 'window.__ref.setZ(z)', view);
  const site = await journey(software, `site, ${name}`, '/', 'window.__perspective.setZ(z)', view);
  if (site.drawnBy !== 'SVG') failures.push(`without a graphics chip the site must stay with its SVG, but it was drawn by ${site.drawnBy}`);
  if (site.script > LIMITS.svg) failures.push(`the site's script took ${site.script.toFixed(2)} ms per frame at ${name} (limit ${LIMITS.svg})`);
}
const forced = await journey(software, 'site, renderer forced, 1280 x 820 at 1x', '/?gpu=webgl2', 'window.__perspective.setZ(z)', { width: 1280, height: 820, scale: 1 });
if (forced.drawnBy !== 'webgl2') failures.push('the renderer did not take over when asked for by address');
if (forced.script > LIMITS.renderer) failures.push(`with the renderer, the page's script took ${forced.script.toFixed(2)} ms per frame (limit ${LIMITS.renderer})`);
console.log('\nFirst load on a phone-sized window (390 x 844 at 3x), empty cache, in software. Seconds from the start of navigation.\n');
console.log(LOADING_HEAD);
for (const [label, net] of NETWORKS) await loading(software, label, net);
await software.close();
}

// ---- on the graphics chip, where there is one
const chipArgs = [...(process.platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=default', '--enable-gpu']), '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'];
let chip = null;
if (only !== 'software') try { chip = await chromium.launch({ args: chipArgs, ignoreDefaultArgs: ['--enable-unsafe-swiftshader'], headless: !inWindow }); } catch { /* cannot be launched that way here */ }
let drawsWith = 'none';
if (chip) {
  const page = await chip.newPage();
  await page.goto(ORIGIN + '/fonts/OFL-Inter.txt');
  drawsWith = await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'); const e = gl && gl.getExtension('WEBGL_debug_renderer_info'); return gl && e ? String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : 'none'; });
  await page.close();
}
if (only === 'software') {
  // not asked for
} else if (!chip || /swiftshader|llvmpipe|software|none/i.test(drawsWith)) {
  console.log('\nNo graphics chip on this machine (' + drawsWith + '): the figures above are all it can say.');
} else {
  console.log(`\nOn the graphics chip: ${drawsWith}, ${inWindow ? 'in a window' : 'headless'}.\n`);
  console.log(FLIGHT_HEAD);
  for (const view of [{ width: 1280, height: 820, scale: 1 }, { width: 1920, height: 820, scale: 2 }, { width: 390, height: 844, scale: 3 }]) {
    const name = `${view.width} x ${view.height} at ${view.scale}x`;
    await journey(chip, `site, SVG kept, ${name}`, '/?original', 'window.__perspective.setZ(z)', view);
    await journey(chip, `site, ${name}`, '/?gpu=webgl2', 'window.__perspective.setZ(z)', view);
    await journey(chip, `site, ${name}`, '/?gpu=webgpu', 'window.__perspective.setZ(z)', view);
    await journey(chip, `site as it chooses, ${name}`, '/', 'window.__perspective.setZ(z)', view);
  }
  // what milestone 3 will ask of it: a hundred thousand marks on screen at once, on top of the drawing
  const big = { width: 1920, height: 820, scale: 2 };
  await journey(chip, 'site with 100,000 more marks, 1920 x 820 at 2x', '/?gpu=webgl2&marks=100000', 'window.__perspective.setZ(z)', big);
  await journey(chip, 'site with 100,000 more marks, 1920 x 820 at 2x', '/?gpu=webgpu&marks=100000', 'window.__perspective.setZ(z)', big);
  console.log('\nFirst load on a phone-sized window (390 x 844 at 3x), empty cache, on the chip. Seconds from the start of navigation.\n');
  console.log(LOADING_HEAD);
  for (const [label, net] of NETWORKS) await loading(chip, label, net);
}
if (chip) await chip.close();
server.kill();
if (check && failures.length) {
  console.error('\nSpeed check failed:\n- ' + failures.join('\n- '));
  process.exit(1);
}
