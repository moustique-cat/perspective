// Start-up. This script is inlined in the page right after the markup of the first view, so
// it runs as soon as that markup has arrived: before the fonts, and before the layers that
// are not visible yet, which follow it in the same response.
import './fonts.css';
import './generated/design.css';
import './site.css';
import { bindings, props as designProps } from './generated/page.js';
import { ZMAX, ZMIN } from './design';
import { mountPage, type Binding } from './dom';
import { computeFrame, panAt, type Frame, type Props } from './frame';
import { GL_ATTRIBUTES, isSoftware, rendererOf } from './gpu/attributes';
import type { Host, Running, Start, StartOptions } from './gpu/host';
import { Journey } from './journey';
import { readProps } from './props';
import { sheets } from './sheets';

declare global {
  interface Window {
    /** Called by the inline script that follows each late layer in the document. */
    __L?: () => void;
    /** The running journey, for tests and the console. */
    __perspective?: Journey;
    /** The renderer once it has taken over; null once it is settled that the SVG stays. */
    __gpu?: Running | null;
    /** Set by a test before the page loads: a deliberate fault for the renderer to draw (src/gpu/host.ts). */
    __fault?: StartOptions['fault'];
  }
}

/** Where the built renderer files are; filled in by the build (scripts/build.mjs). */
declare const __GPU_FILES__: { webgl2: string; webgpu: string; bench: string } | undefined;

/** The zoom is noted here when the page is left, so that ?original can be added or removed without losing one's place. */
const PLACE = 'perspective';
const original = /[?&]original(=|&|$)/.test(location.search);

const doc = document.documentElement;

/** Resolves when it is settled what the words will be set over (see arrive). */
function start(): Promise<void> {
  const root = document.querySelector<HTMLElement>('.ink');
  if (!root) throw new Error('page markup missing');
  const page = mountPage(root, bindings as Binding[]);
  const media = (query: string) => typeof matchMedia === 'function' && matchMedia(query).matches;
  const reduced = media('(prefers-reduced-motion: reduce)');
  const props = readProps(location.search, designProps as Props);
  // every frame goes to the page; once the renderer has taken the drawing over, to it as well
  let frame: Frame | null = null, also: ((f: Frame) => void) | null = null;
  const journey = new Journey(
    {
      raf: (cb) => requestAnimationFrame(cb),
      reduced,
      coarse: media('(pointer: coarse)'),
    },
    props,
    (f) => { frame = f; page.apply(f); if (also) also(f); },
  );
  // Arriving from the same place in the other drawing (?original added or removed): start where that one was.
  try {
    const was = JSON.parse(sessionStorage.getItem(PLACE) || 'null');
    if (was && was.o !== original && typeof was.z === 'number') journey.z = journey.zT = Math.min(ZMAX, Math.max(ZMIN, was.z));
  } catch { /* no storage: start at Moustique */ }
  window.addEventListener('pagehide', () => {
    try { sessionStorage.setItem(PLACE, JSON.stringify({ z: journey.z, o: original })); } catch { /* no storage */ }
  });

  const handlers: Record<string, (e: Event, arg?: string) => void> = {
    onWheel: (e) => journey.onWheel(e as WheelEvent),
    onRange: (e) => journey.onRange((e.target as HTMLInputElement).value),
    onRailKey: (e) => journey.onRailKey(e as KeyboardEvent),
    onPd: (e) => {
      const p = e as PointerEvent;
      if (!journey.onPtrDown(p)) return;
      try { (p.currentTarget as Element).setPointerCapture(p.pointerId); } catch { /* pointer already gone */ }
    },
    onPm: (e) => journey.onPtrMove(e as PointerEvent),
    onPu: (e) => journey.onPtrUp(e as PointerEvent),
    flyOut: () => journey.toggle(1),
    flyIn: () => journey.toggle(-1),
    goHome: () => journey.home(),
    pick: (_e, arg) => journey.pick(Number(arg)),
  };
  for (const { el, type, handler, arg } of page.events) {
    const fn = handlers[handler];
    if (!fn) throw new Error('no handler for ' + handler);
    el.addEventListener(type, (e) => fn(e, arg), type === 'wheel' ? { passive: true } : undefined);
  }

  // On a page of its own the wheel must not also zoom or swipe the browser itself (a trackpad
  // pinch arrives as ctrl+wheel), so the page has to claim it with a blocking listener. That
  // listener sits on the three parts that between them are under every point of the page, and
  // NOT on the root or the window. A blocking wheel or touch listener over the whole page
  // makes Chromium split the page into compositing layers differently: while a faded group is
  // on screen (the "Moustique is here" ring appearing, for one) lines land a fraction of a
  // pixel softer and text can change its anti-aliasing. Placed like this the listener
  // changes no pixel; e2e/compare.ts refuses to compare a page that has one on its root.
  const claim = (e: Event) => e.preventDefault();
  root.querySelectorAll('.stage, .rail, [role="group"]').forEach((el) => el.addEventListener('wheel', claim, { passive: false }));

  // Safari reports a trackpad pinch as gesture events with a running scale, not as a wheel.
  let scale = 1;
  root.addEventListener('gesturestart', (e) => { e.preventDefault(); scale = 1; });
  root.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    const now = (e as Event & { scale?: number }).scale || 1;
    if (!journey.touching) journey.onPinch(now / scale);
    scale = now;
  });
  root.addEventListener('gestureend', (e) => e.preventDefault());

  const fit = () => journey.resize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', fit);
  fit();

  // Layers that are not on screen at the home zoom arrive after this script, each in a
  // <template>. Moving one into place costs nothing while it is hidden; if the zoom has
  // already reached it, it fades in rather than popping.
  const adopt = (tpl: HTMLTemplateElement) => {
    const g = page.layer(tpl.getAttribute('data-for') || '');
    const drawing = tpl.content.firstElementChild;
    if (g && drawing) {
      const onScreen = g.getAttribute('display') !== 'none';
      g.append(...Array.from(drawing.childNodes));
      if (onScreen && !reduced && typeof g.animate === 'function') {
        g.animate([{ opacity: 0 }, {}], { duration: 240, easing: 'ease-out' });
      }
    }
    tpl.remove();
  };
  document.querySelectorAll<HTMLTemplateElement>('template[data-for]').forEach(adopt);
  window.__L = () => {
    const script = document.currentScript;
    const tpl = script && script.previousElementSibling;
    if (tpl instanceof HTMLTemplateElement) adopt(tpl);
    if (script) script.remove();
  };

  window.__perspective = journey;
  performance.mark('zoomable');

  // ?bench: the speed report (src/bench.ts), a file of its own
  if (/[?&]bench(=|&|$)/.test(location.search)) {
    (import.meta.env.DEV ? import('./bench') : import(/* @vite-ignore */ new URL(__GPU_FILES__!.bench, document.baseURI).href)).then((m) => m.run(ZMIN, ZMAX));
  }

  return arrive({
    root, svg: root.querySelector('svg')!, props, reduced, journey, sheets: sheets(),
    panAt: (z) => panAt(z, props),
    onFrame: (callback) => { also = callback; },
    frame: () => frame,
    frameAt: (z) => computeFrame({ z, playing: 0, vw: journey.vw, vh: journey.vh, jump: null, announce: '', coarse: false, props }, { a: { key: '', t: '', d: '' }, b: { key: '', t: '', d: '' }, on: 'a' }),
    mute: page.mute,
  });
}

/**
 * Brings in the renderer, if this device has a graphics chip to run it on: WebGPU where there
 * is one, WebGL2 otherwise. Nothing is fetched until the whole drawing has arrived and the
 * page is idle, and nothing at all on a device that stays with the SVG. The SVG is on screen
 * throughout; the renderer takes over behind it (src/gpu/renderer.ts).
 *
 * ?original keeps the SVG, as does ?hand (the pencil line is an SVG filter).
 * ?gpu=webgl2, ?gpu=webgpu and ?gpu=svg choose outright, software rendering included: for tests.
 */
function arrive(host: Host): Promise<void> {
  const asked = /[?&]gpu=(\w+)/.exec(location.search);
  const want = asked ? asked[1] : '';
  // ?marks=100000: the speed report's load test (src/gpu/renderer.ts)
  const marks = /[?&]marks=(\d+)/.exec(location.search);
  const fault = window.__fault || (marks ? { extra: +marks[1] } : undefined);
  if (original || host.props.handDrawn || want === 'svg') { window.__gpu = null; return Promise.resolve(); }
  const load = async (kind: 'webgpu' | 'webgl2', options: StartOptions): Promise<Running | null> => {
    let renderer: { start: Start };
    if (import.meta.env.DEV) {
      renderer = kind === 'webgpu' ? await import('./gpu/entry-webgpu') : await import('./gpu/entry-webgl2');
    } else {
      renderer = await import(/* @vite-ignore */ new URL(__GPU_FILES__![kind], document.baseURI).href);
    }
    return renderer.start(host, options);
  };
  // What does this device draw with? WebGL can tell without asking for WebGPU, which logs a
  // warning where there is none. The canvas is not in the page: next to the SVG it would
  // change how the browser draws the SVG.
  let canvas: HTMLCanvasElement | null = null, gl: WebGL2RenderingContext | null = null;
  const look = (): boolean => {
    canvas = document.createElement('canvas');
    gl = canvas.getContext('webgl2', GL_ATTRIBUTES);
    return !!want || (!!gl && !isSoftware(rendererOf(gl)));
  };
  const go = async (): Promise<Running | null> => {
    if (!canvas && !look()) return null;
    const mine = canvas!, context = gl;
    canvas = null;
    let running: Running | null = null;
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
    if (want !== 'webgl2' && gpu) {
      const adapter = await gpu.requestAdapter().catch(() => null);
      if (adapter) running = await load('webgpu', { force: !!want, adapter, fault }).catch(() => null);
    }
    if (running) {
      // the WebGL context was only made to find out
      const ext = context && context.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    } else if (context && want !== 'webgpu') {
      running = await load('webgl2', { force: !!want, canvas: mine, fault });
    }
    return running;
  };
  let tries = 0;
  const begin = (): void => {
    const idle = (): void => {
      go().catch((e) => { console.info('Perspective: the drawing stays as SVG (' + e + ')'); return null; }).then((running) => {
        window.__gpu = running;
        // if the chip is taken away (a phone does that to pages in the background) the SVG is back at once;
        // the renderer is brought in again when the page is next looked at, a few times at most
        if (running) running.gone.then(() => { window.__gpu = null; if (++tries < 4) whenSeen(begin); });
      });
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(idle, { timeout: 2000 }); else setTimeout(idle, 200);
  };
  const whenSeen = (then: () => void): void => {
    if (document.visibilityState === 'visible') { setTimeout(then, 1000); return; }
    document.addEventListener('visibilitychange', () => whenSeen(then), { once: true });
  };
  // Settled at once, before the words are shown: will a canvas come to lie under them? A browser
  // smooths text differently once it sits over a canvas (on Windows and Linux, in grey rather than
  // with coloured fringes). So a device that will get the renderer is given a white sheet under
  // everything now: the words are then set over a layer of their own from the moment they appear,
  // and do not change in front of the reader when the canvas arrives.
  return new Promise((settled) => setTimeout(() => {
    if (look()) {
      const sheet = document.createElement('div');
      sheet.setAttribute('aria-hidden', 'true');
      sheet.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;background:#FFFFFF;will-change:transform;pointer-events:none';
      host.root.insertBefore(sheet, host.root.firstChild);
      if (document.readyState === 'complete') begin(); else window.addEventListener('load', begin);
    } else {
      // no graphics chip: the SVG stays, and nothing was added to the page
      const ext = gl && (gl as WebGL2RenderingContext).getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
      canvas = null;
      window.__gpu = null;
    }
    settled();
  }, 0));
}

function showWords(): void {
  doc.classList.add('fonts');
  // The italic is only used for the quark labels at the very bottom of the zoom, so the
  // browser would fetch it on arrival there and swap it in. Fetch it once things are quiet.
  const fonts = document.fonts;
  const warm = () => { fonts.load("italic 400 16px 'EB Garamond'", 'ud').catch(() => {}); };
  if (fonts && typeof fonts.load === 'function') {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 4000 });
    else setTimeout(warm, 1500);
  }
}

let settled: Promise<void> = Promise.resolve();
try {
  settled = start();
} finally {
  // The drawing shows at once. The words wait a moment for their fonts, so they appear
  // already set in the right type rather than changing face in front of the reader.
  doc.classList.add('ready');
  const fonts = document.fonts;
  if (fonts && typeof fonts.load === 'function') {
    const wanted = ["400 13px Inter", "500 14px Inter", "600 13px Inter", "400 34px 'EB Garamond'"].map((f) => fonts.load(f));
    Promise.race([Promise.all(wanted), new Promise((done) => setTimeout(done, 400))]).then(() => settled).then(showWords, showWords);
  } else {
    settled.then(showWords, showWords);
  }
}
