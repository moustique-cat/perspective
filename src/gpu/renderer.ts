// The renderer: takes the drawing over from the SVG and draws every frame on the chip.
//
// Each frame it is handed the very values the page writes into the SVG (scales, offsets,
// opacities, as text) and turns them into a short list of draws: per visible layer one scale,
// one offset, and for each batch of marks how many are on screen. No mark is touched.
import type { Frame } from '../frame';
import { C_CIRCLE, C_FILL, C_MARKS, C_OVER, type Backend, type Box, type Command, type FramePlan, type Placement, type Uploaded } from './backend';
import type { Host, Running, SheetInfo } from './host';
import { levelBuilder, type Reply, type Request } from './levels';
import { ATMOSPHERE, EARTH, readPage, type PageScene } from './page';
import { B_FILL, B_INK, fadesInPlace, within, type Level } from './scene';

/** How far a curve's straight segments may stray from it at the top of a level's range, device px. */
const TOLERANCE = 0.02;
/** The artboard the drawing's coordinates belong to. */
const DESIGN_W = 1280, DESIGN_H = 820;
/** Levels asked for at once: enough to keep the worker busy, few enough to re-aim quickly. */
const IN_FLIGHT = 2;
/** Every third level is built before the renderer takes over, so there is always one close enough to fall back on. */
const ANCHOR_EVERY = 3;
const FADE_MS = 260;

interface Slot {
  e: number;
  asked: boolean;
  level: Level | null;
  gpu: Uploaded | null;
  /** The radius it was asked for; a window that grows can outgrow it. */
  radius: number;
}

interface Sheet {
  name: string;
  index: number;
  info: SheetInfo;
  slots: Map<number, Slot>;
  /** Around its marks, in its own units. */
  box: Box | null;
  /** Straight lines only: one level serves every scale. */
  single: boolean;
}

interface Placed { shown: boolean; scale: number; x: number; y: number; opacity: number }

const HIDDEN: Placed = { shown: false, scale: 1, x: 0, y: 0, opacity: 0 };

export async function run(host: Host, backend: Backend, makeWorker: (() => Worker) | null): Promise<Running | null> {
  let scene: PageScene;
  try {
    scene = readPage(host.svg);
  } catch (e) {
    console.info('Perspective: the drawing stays as SVG (' + (e as Error).message + ')');
    backend.destroy();
    return null;
  }
  const canvas = backend.canvas;
  const sheets: Sheet[] = scene.sheets.map((raw, index) => {
    const info = host.sheets[raw.name];
    if (!info) throw new Error('no placement known for ' + raw.name);
    return { name: raw.name, index, info, slots: new Map(), box: null, single: raw.name === 'ground' };
  });
  const stats = { marks: 0, calls: 0, groups: 0, levels: 0, bytes: 0 };
  let stopped = false, took = false;

  // ---- levels: asked of the worker nearest the traveller first
  let post: (request: Request) => void;
  let inFlight = 0, nextId = 1;
  const waiting = new Map<number, { sheet: Sheet; slot: Slot }>();
  let onReply: (() => void)[] = [];
  const receive = (reply: Reply): void => {
    const hit = waiting.get(reply.id);
    waiting.delete(reply.id);
    inFlight--;
    if (stopped || !hit) return;
    if (reply.level) {
      const { sheet, slot } = hit;
      if (slot.gpu) { stats.bytes -= slot.gpu.bytes; backend.release(slot.gpu); } else stats.levels++;
      slot.level = reply.level;
      slot.gpu = backend.upload(reply.level);
      stats.bytes += slot.gpu.bytes;
      // the chip has the records now; only the distances are needed here
      reply.level.records = new ArrayBuffer(0);
      if (reply.box) sheet.box = reply.box;
      if (took && shownNow(sheet)) redraw();
    } else if (reply.error) {
      console.warn('Perspective: ' + hit.sheet.name + ': ' + reply.error);
    }
    pump();
    const told = onReply;
    onReply = [];
    told.forEach((f) => f());
  };
  const local = (): void => {
    const build = levelBuilder();
    const queue: Request[] = [];
    let busy = false;
    const step = (): void => {
      const request = queue.shift();
      if (!request) { busy = false; return; }
      const out = build(request);
      if (out) receive(out.reply);
      setTimeout(step, 0);
    };
    post = (request) => { queue.push(request); if (!busy) { busy = true; setTimeout(step, 0); } };
  };
  let worker: Worker | null = null;
  if (makeWorker) {
    try {
      worker = makeWorker();
      const w = worker;
      w.onmessage = (e: MessageEvent<Reply>) => receive(e.data);
      // a worker that cannot start (blocked, or the file is missing): build on the page instead
      w.onerror = () => {
        w.terminate();
        worker = null;
        local();
        post({ t: 0, sheets: scene.sheets, widths: scene.widths });
        for (const w2 of waiting.values()) w2.slot.asked = false;
        waiting.clear();
        inFlight = 0;
        pump();
      };
      post = (request) => w.postMessage(request);
    } catch {
      local();
    }
  } else {
    local();
  }
  post!({ t: 0, sheets: scene.sheets, widths: scene.widths });

  // ---- the window
  let W = 0, H = 0, dpr = 1, sc = 1, offX = 0, offY = 0;
  const measure = (): boolean => {
    const w = host.journey.vw, h = host.journey.vh, d = window.devicePixelRatio || 1;
    if (!(w > 0 && h > 0)) return false;
    if (w !== W || h !== H || d !== dpr) {
      W = w; H = h; dpr = d;
      sc = Math.max(W / DESIGN_W, H / DESIGN_H);
      offX = (W - DESIGN_W * sc) / 2; offY = (H - DESIGN_H * sc) / 2;
      backend.resize(Math.round(W * dpr), Math.round(H * dpr));
      backend.setWidths(scene.widths.map((w2) => w2 * dpr / 2));
    }
    return true;
  };
  /** The largest half stroke width plus room for smoothing, device px. */
  const pad = (): number => Math.max(...scene.widths) * dpr / 2 + 2;
  /** Device px per drawing unit. */
  const density = (): number => sc * dpr;

  // ---- where a sheet is in a frame
  const num = (text: string, from: number): number => parseFloat(text.slice(from));
  const placed = (frame: Frame, sheet: Sheet, pan: [number, number]): Placed => {
    if (sheet.name === 'ground') {
      const g = frame.ground;
      return g.d === 'none' ? HIDDEN : { shown: true, scale: 1, x: pan[0], y: pan[1] + Number(g.y), opacity: Number(g.o) };
    }
    if (sheet.name === 'grid') {
      const g = frame.grid;
      if (g.d === 'none') return HIDDEN;
      // "translate(0 Y) scale(S)"
      const at = g.t.indexOf(') scale(');
      return { shown: true, scale: num(g.t, at + 8), x: pan[0], y: pan[1] + num(g.t, 12), opacity: Number(g.o) };
    }
    const v = frame.v[sheet.name];
    // "scale(S)"
    return v.d === 'none' ? HIDDEN : { shown: true, scale: num(v.t, 6), x: pan[0], y: pan[1], opacity: Number(v.o) };
  };
  const panOf = (frame: Frame): [number, number] => {
    // "translate(X Y)"
    const at = frame.pan.indexOf(' ');
    return [num(frame.pan, 10), num(frame.pan, at + 1)];
  };
  const shownNow = (sheet: Sheet): boolean => {
    const frame = host.frame();
    return !!frame && placed(frame, sheet, [0, 0]).shown;
  };

  // ---- which level, and asking for the ones missing
  const exponent = (sheet: Sheet, k: number): number => (sheet.single ? 0 : Math.floor(Math.log2(k)));
  const range = (sheet: Sheet): [number, number] => {
    if (sheet.single) return [0, 0];
    const d = density();
    return [exponent(sheet, sheet.info.scale(sheet.info.to) * d), exponent(sheet, sheet.info.scale(sheet.info.from) * d)];
  };
  /** The zoom at the middle of a level's range of scales. */
  const zoomOf = (sheet: Sheet, e: number): number => {
    if (sheet.single) return (sheet.info.from + sheet.info.to) / 2;
    const target = Math.pow(2, e + 0.5) / density();
    // scale falls as the zoom rises: bisect
    let lo = sheet.info.from - 1, hi = sheet.info.to + 1;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (sheet.info.scale(mid) > target) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  };
  /** The point of a sheet that sits at the middle of the view at a zoom, in its own units. */
  const centreOf = (sheet: Sheet, z: number): [number, number] => {
    if (sheet.name === 'ground') return [0, 0];
    if (sheet.name === 'grid') return [0, -100];
    const pan = host.panAt(z), s = sheet.info.scale(z);
    return [-pan[0] / s, -pan[1] / s];
  };
  /** How far the corner of the window furthest from the view's fixed point is from it, device px. */
  const reachOfWindow = (): number => {
    const frame = host.frame();
    if (!frame) return 0;
    const vb = frame.vb.split(' ');
    const ax = (-Number(vb[0]) * sc + offX) * dpr, ay = (-Number(vb[1]) * sc + offY) * dpr;
    const w = W * dpr, h = H * dpr;
    return Math.hypot(Math.max(ax, w - ax), Math.max(ay, h - ay));
  };
  const ask = (sheet: Sheet, e: number): void => {
    let slot = sheet.slots.get(e);
    if (!slot) { slot = { e, asked: false, level: null, gpu: null, radius: 0 }; sheet.slots.set(e, slot); }
    const z = zoomOf(sheet, e);
    const origin = centreOf(sheet, z);
    let radius = Infinity, tolerance = 1;
    if (!sheet.single) {
      // room for the window to grow a little, and for the view's centre moving within the level's range
      const reach = Math.ceil(reachOfWindow() * 1.15 / 128) * 128 + pad();
      const span = Math.log10(2) / 2;
      let drift = 0;
      for (const dz of [-span, span]) {
        const c = centreOf(sheet, z + dz);
        drift = Math.max(drift, Math.hypot(c[0] - origin[0], c[1] - origin[1]));
      }
      radius = reach / Math.pow(2, e) + drift;
      tolerance = TOLERANCE / Math.pow(2, e + 1);
    }
    slot.asked = true;
    slot.radius = radius;
    const id = nextId++;
    waiting.set(id, { sheet, slot });
    inFlight++;
    post({ t: 1, id, sheet: sheet.index, tolerance, origin: [Math.fround(origin[0]), Math.fround(origin[1])], radius });
  };
  /** The best level there is for a scale: the finest one not finer than wanted, reaching far enough if possible. */
  const pick = (sheet: Sheet, e: number, limit: number): Slot | null => {
    let best: Slot | null = null, short: Slot | null = null;
    for (const slot of sheet.slots.values()) {
      if (!slot.gpu || slot.e > e) continue;
      if (slot.level!.radius >= limit) { if (!best || slot.e > best.e) best = slot; }
      else if (!short || slot.e > short.e) short = slot;
    }
    return best || short;
  };
  /** Levels the frame just planned would have used, had they been there. */
  const wanted: { sheet: Sheet; e: number }[] = [];
  const pump = (): void => {
    if (stopped) return;
    while (inFlight < IN_FLIGHT) {
      const next = choose();
      if (!next) break;
      ask(next.sheet, next.e);
    }
  };
  /** What to build next: what the current view lacks, then the anchors, then everything else; nearest in zoom first. */
  const choose = (): { sheet: Sheet; e: number } | null => {
    while (wanted.length) {
      const w = wanted.shift()!;
      const slot = w.sheet.slots.get(w.e);
      if (!slot || !slot.asked) return w;
    }
    const z = host.journey.z, heading = host.journey.playing || Math.sign(host.journey.zT - z);
    const ahead = z + 0.6 * heading;
    let best: { sheet: Sheet; e: number } | null = null, bestScore = Infinity;
    for (const sheet of sheets) {
      const [lo, hi] = range(sheet);
      for (let e = lo; e <= hi; e++) {
        const slot = sheet.slots.get(e);
        if (slot && slot.asked) continue;
        const anchor = e === lo || (e - lo) % ANCHOR_EVERY === 0;
        const score = Math.abs(zoomOf(sheet, e) - ahead) + (anchor ? 0 : 100);
        if (score < bestScore) { bestScore = score; best = { sheet, e }; }
      }
    }
    return best;
  };
  const anchorsReady = (): boolean => sheets.every((sheet) => {
    const [lo, hi] = range(sheet);
    for (let e = lo; e <= hi; e += ANCHOR_EVERY) { const slot = sheet.slots.get(e); if (!slot || !slot.gpu) return false; }
    return true;
  });

  // ---- one frame
  const plan: FramePlan = { ink: [0, 0, 0], groups: [], commands: [] };
  let lacking = 0;
  const build = (frame: Frame): void => {
    plan.groups.length = 0;
    plan.commands.length = 0;
    stats.marks = 0; stats.calls = 0; stats.groups = 0;
    lacking = 0;
    wanted.length = 0;
    const hex = /^#([0-9a-f]{6})$/i.exec(frame.ink);
    const rgb = hex ? parseInt(hex[1], 16) : 0x141414;
    plan.ink = [(rgb >> 16) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255];
    const vb = frame.vb.split(' '), vbx = Number(vb[0]), vby = Number(vb[1]);
    const pan = panOf(frame);
    const d = density(), w = W * dpr, h = H * dpr, edge = pad();
    const toX = (x: number): number => ((x - vbx) * sc + offX) * dpr, toY = (y: number): number => ((y - vby) * sc + offY) * dpr;
    const clip = (l: number, t: number, r: number, b: number): Box | null => {
      const box: Box = [Math.max(0, Math.floor(l - edge)), Math.max(0, Math.floor(t - edge)), Math.min(w, Math.ceil(r + edge)), Math.min(h, Math.ceil(b + edge))];
      return box[0] < box[2] && box[1] < box[3] ? box : null;
    };
    const dash = (on: number, off: number): [number, number] => [on * dpr, off * dpr];

    for (const which of scene.order) {
      if (which === ATMOSPHERE || which === EARTH) {
        const c = which === EARTH ? frame.earth : frame.atm;
        if (c.d === 'none') continue;
        const radius = Number(c.r) * d;
        const cx = toX(pan[0]), cy = toY(pan[1] + Number(c.cy));
        const box = clip(cx - radius, cy - radius, cx + radius, cy + radius);
        if (!box || !(radius > 0)) continue;
        // the point of the circle nearest the middle of the window
        let nx = w / 2 - cx, ny = h / 2 - cy;
        const far = Math.hypot(nx, ny);
        if (far > 1e-6) { nx /= far; ny /= far; } else { nx = 0; ny = -1; }
        const style = which === EARTH ? null : scene.atmosphere;
        let turn = Math.atan2(ny, nx);
        if (turn < 0) turn += 2 * Math.PI;
        const lengths = style ? dash(style.dash[0], style.dash[1]) : null;
        plan.commands.push({
          op: C_CIRCLE, box, near: [cx + nx * radius, cy + ny * radius, nx, ny], radius,
          width: style ? style.width : scene.earth.width, filled: which === EARTH,
          dash: lengths ? [lengths[0], lengths[1], (radius * turn) % (lengths[0] + lengths[1])] : null,
          opacity: Number(c.o) * (style ? style.opacity : 1),
        });
        stats.calls++;
        continue;
      }
      const sheet = sheets[which];
      const p = placed(frame, sheet, pan);
      if (!p.shown) continue;
      const k = p.scale * d;
      const e = exponent(sheet, k);
      if (sheet.box) {
        const b = sheet.box;
        if (!clip(toX(b[0] * p.scale + p.x), toY(b[1] * p.scale + p.y), toX(b[2] * p.scale + p.x), toY(b[3] * p.scale + p.y))) continue;
      }
      // how far from a level's origin a mark can be and still touch the window: the origin's distance to the furthest corner
      const limitFrom = (origin: [number, number]): [Placement, number] => {
        const ox = toX(origin[0] * p.scale + p.x), oy = toY(origin[1] * p.scale + p.y);
        return [[k, ox, oy], (Math.hypot(Math.max(ox, w - ox), Math.max(oy, h - oy)) + edge) / k];
      };
      const ideal = sheet.slots.get(e);
      const rough = limitFrom(centreOf(sheet, host.journey.z))[1];
      const slot = pick(sheet, e, rough);
      if (!ideal || !ideal.asked) wanted.push({ sheet, e });
      if (!slot) { lacking++; continue; }
      if (slot.e !== e) lacking++;
      const level = slot.level!, gpu = slot.gpu!;
      const [at, limit] = limitFrom(level.origin);
      // a window that has grown past what this level was cut for: have it built again, wider
      if (limit > level.radius && slot.e === e && slot.radius === level.radius && !sheet.single) { slot.asked = false; wanted.push({ sheet, e }); }
      const fading = p.opacity < 0.9995, inPlace = fading && fadesInPlace(level);
      const commands: Command[] = fading && !inPlace ? [] : plan.commands;
      level.batches.forEach((batch, i) => {
        if (batch.kind === B_FILL) {
          commands.push({ op: C_FILL, level: gpu, first: batch.first, count: batch.count, at });
          stats.calls++;
          return;
        }
        const count = within(batch, limit);
        if (!count) return;
        const gather = batch.kind !== B_INK || inPlace;
        commands.push({ op: C_MARKS, level: gpu, batch: i, count, at, gather, opacity: batch.opacity * (inPlace ? p.opacity : 1), dash: batch.dash ? dash(batch.dash[0], batch.dash[1]) : null });
        stats.marks += count;
        stats.calls += gather ? 2 : 1;
      });
      if (fading && !inPlace && commands.length) {
        const b = sheet.box!;
        const box = clip(toX(b[0] * p.scale + p.x), toY(b[1] * p.scale + p.y), toX(b[2] * p.scale + p.x), toY(b[3] * p.scale + p.y));
        if (!box) continue;
        plan.commands.push({ op: C_OVER, group: plan.groups.length, opacity: p.opacity, box });
        plan.groups.push({ box, commands });
        stats.groups++;
        stats.calls++;
      }
    }
  };
  const draw = (frame: Frame): void => {
    if (stopped || !measure()) return;
    build(frame);
    backend.draw(plan);
    pump();
  };
  const redraw = (): void => {
    const frame = host.frame();
    if (frame) draw(frame);
  };

  // ---- taking over from the SVG
  await backend.ready();
  if (!measure()) throw new Error('the window has no size yet');
  // prime: what the current view needs, then the anchors
  await new Promise<void>((resolve) => {
    const check = (): void => {
      if (stopped) { resolve(); return; }
      const frame = host.frame();
      if (frame && measure()) {
        build(frame);
        pump();
        if (!lacking && anchorsReady()) { resolve(); return; }
      }
      setTimeout(check, 16);
    };
    check();
  });
  if (stopped) return null;

  // Stacking: the SVG drawing, then the canvas over it, then everything the design paints after
  // the drawing (labels, the Sun, the marker), moved into an SVG of its own on top. The canvas
  // is an opaque picture, so it can simply fade in over the SVG drawing: the browser blends an
  // ordinary page layer without redrawing what is under it. (Fading the SVG group away
  // instead would make Chromium redraw it softer for the length of the fade.)
  const drawing = scene.drawing;
  const pan = drawing.parentNode as SVGGElement;
  const top = host.svg.cloneNode(false) as SVGSVGElement, topPan = pan.cloneNode(false) as SVGGElement;
  top.removeAttribute('data-b');
  topPan.removeAttribute('data-b');
  top.appendChild(topPan);
  while (drawing.nextSibling) topPan.appendChild(drawing.nextSibling);
  let box = '', shift = '';
  const follow = (frame: Frame): void => {
    if (frame.vb !== box) top.setAttribute('viewBox', box = frame.vb);
    if (frame.pan !== shift) topPan.setAttribute('transform', shift = frame.pan);
  };
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block;pointer-events:none;opacity:0';
  host.root.insertBefore(top, host.svg.nextSibling);
  host.root.insertBefore(canvas, top);
  const each = (frame: Frame): void => { follow(frame); draw(frame); };
  redraw();
  took = true;
  let over: () => void = () => {};
  const handed = new Promise<void>((resolve) => { over = resolve; });
  const hide = (): void => {
    canvas.style.opacity = '';
    drawing.style.display = 'none';
    host.mute(drawing);
    over();
  };
  const moving = host.journey.playing !== 0 || host.journey.z !== host.journey.zT;
  host.onFrame(each);
  if (moving || host.reduced || typeof canvas.animate !== 'function') {
    // in motion every frame differs from the last anyway: change over between two frames
    hide();
  } else {
    // at rest: the chip's picture fades in over the same picture drawn by the SVG
    const fade = canvas.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'linear' });
    const end = (): void => { if (!stopped) hide(); };
    fade.onfinish = end;
    fade.oncancel = end;
  }
  // a window moved to a screen of another density
  let density0 = window.matchMedia ? window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`) : null;
  const rescale = (): void => {
    if (density0) density0.removeEventListener('change', rescale);
    density0 = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    density0.addEventListener('change', rescale);
    redraw();
  };
  if (density0) density0.addEventListener('change', rescale);

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    host.onFrame(null);
    if (density0) density0.removeEventListener('change', rescale);
    // the SVG is still there, and current as soon as its values are written again
    drawing.style.display = '';
    while (topPan.firstChild) pan.appendChild(topPan.firstChild);
    top.remove();
    host.mute(null);
    host.journey.render();
    canvas.remove();
    if (worker) worker.terminate();
    backend.destroy();
    over();
  };
  const gone = new Promise<void>((resolve) => backend.onLost(() => { stop(); resolve(); }));

  return {
    kind: backend.kind,
    chip: backend.chip,
    stats,
    handed,
    gone,
    async snapshot(): Promise<string> {
      redraw();
      const pixels = await backend.read();
      const copy = document.createElement('canvas');
      copy.width = canvas.width; copy.height = canvas.height;
      copy.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer as ArrayBuffer), canvas.width, canvas.height), 0, 0);
      return copy.toDataURL('image/png');
    },
    async settled(): Promise<void> {
      for (;;) {
        redraw();
        if (stopped || (!lacking && !wanted.length)) return;
        await new Promise<void>((resolve) => onReply.push(resolve));
      }
    },
    stop,
  };
}
