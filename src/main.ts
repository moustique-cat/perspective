// Start-up. This script is inlined in the page right after the markup of the first view, so
// it runs as soon as that markup has arrived: before the fonts, and before the layers that
// are not visible yet, which follow it in the same response.
import './fonts.css';
import './generated/design.css';
import './site.css';
import { bindings, props as designProps } from './generated/page.js';
import { mountPage, type Binding } from './dom';
import type { Props } from './frame';
import { Journey } from './journey';
import { readProps } from './props';

declare global {
  interface Window {
    /** Called by the inline script that follows each late layer in the document. */
    __L?: () => void;
    /** The running journey, for tests and the console. */
    __perspective?: Journey;
  }
}

const doc = document.documentElement;

function start(): void {
  const root = document.querySelector<HTMLElement>('.ink');
  if (!root) throw new Error('page markup missing');
  const page = mountPage(root, bindings as Binding[]);
  const media = (query: string) => typeof matchMedia === 'function' && matchMedia(query).matches;
  const reduced = media('(prefers-reduced-motion: reduce)');
  const journey = new Journey(
    {
      raf: (cb) => requestAnimationFrame(cb),
      reduced,
      coarse: media('(pointer: coarse)'),
    },
    readProps(location.search, designProps as Props),
    page.apply,
  );

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
  // pixel softer and text can lose its sub-pixel anti-aliasing. Placed like this the listener
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

try {
  start();
} finally {
  // The drawing shows at once. The words wait a moment for their fonts, so they appear
  // already set in the right type rather than changing face in front of the reader.
  doc.classList.add('ready');
  const fonts = document.fonts;
  if (fonts && typeof fonts.load === 'function') {
    const wanted = ["400 13px Inter", "500 14px Inter", "600 13px Inter", "400 34px 'EB Garamond'"].map((f) => fonts.load(f));
    Promise.race([Promise.all(wanted), new Promise((done) => setTimeout(done, 400))]).then(showWords, showWords);
  } else {
    showWords();
  }
}
