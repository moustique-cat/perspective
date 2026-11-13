// The site's code against the design's own code: every value, at every zoom, and the motion.
import { describe, expect, it } from 'vitest';
import { GAPS, LMS, PRE, ZMAX, ZMIN } from '../src/generated/core.js';
import { computeFrame, type CaptionSlots, type Props } from '../src/frame';
import { Journey } from '../src/journey';
import { originalProps, plain, runOriginal } from './original';

const DESIGN_H = 820;
const defaults = originalProps as unknown as Props;
const slots = (): CaptionSlots => ({ a: { key: '', t: '', d: '' }, b: { key: '', t: '', d: '' }, on: 'a' });

/** Zooms worth checking: a fine sweep, plus every landmark and the edges of every caption and layer window. */
function zooms(step: number): number[] {
  const zs = new Set<number>();
  for (let z = ZMIN; z <= ZMAX + 1e-9; z += step) zs.add(Number(z.toFixed(4)));
  for (const l of LMS) for (const d of [-0.55, -0.5499, -0.001, 0, 0.001, 0.5499, 0.55]) zs.add(l.z + d);
  for (const g of [...GAPS, ...PRE]) for (const edge of [g[0], g[1]]) for (const d of [-0.001, 0, 0.001]) zs.add((edge as number) + d);
  return [...zs].filter((z) => z >= ZMIN && z <= ZMAX).sort((a, b) => a - b);
}

/** Caption slots after the first frame, drawn at the home zoom as the page draws it on start-up. */
function primed(width: number, props: Props): CaptionSlots {
  const cap = slots();
  computeFrame({ z: 0, playing: 0, vw: width, vh: DESIGN_H, jump: null, announce: '', coarse: false, props }, cap);
  return cap;
}

/** The site adds the rail geometry to the frame; everything else must be the original's. */
function withoutRail(frame: unknown): Record<string, unknown> {
  const { rail: _rail, ...rest } = plain(frame) as Record<string, unknown>;
  return rest;
}

describe('every drawn value equals the original', () => {
  const widths = [320, 390, 600, 759, 760, 1024, 1280, 1366, 1440, 1920, 2560, 3840];
  for (const width of widths) {
    it(`at a ${width} px wide window, across the whole zoom`, () => {
      const original = runOriginal({ width });
      const cap = primed(width, defaults);
      let checked = 0;
      for (const z of zooms(0.05)) {
        original.setZ(z);
        const mine = computeFrame({ z, playing: 0, vw: width, vh: DESIGN_H, jump: null, announce: '', coarse: false, props: defaults }, cap);
        const theirs = original.vals();
        // the original's announcement is carried in state; the per-zoom values are what is compared here
        delete theirs.announce;
        const got = withoutRail(mine);
        delete got.announce;
        expect(got, `z = ${z}`).toEqual(theirs);
        checked++;
      }
      expect(checked).toBeGreaterThan(900);
    });
  }

  it('with each design tweak changed', () => {
    const variants: Partial<Props>[] = [
      { moustiqueLengthCm: 20 }, { moustiqueLengthCm: 61 }, { moustiqueLengthCm: 90 }, { moustiqueLengthCm: 7 },
      { ink: '#26304A' }, { ink: '#3B2F27' }, { handDrawn: true }, { flySpeed: 2.5 },
    ];
    for (const change of variants) {
      const props = { ...defaults, ...change };
      const original = runOriginal({ props });
      const cap = primed(1280, props);
      for (const z of zooms(0.25)) {
        original.setZ(z);
        const theirs = original.vals();
        delete theirs.announce;
        const got = withoutRail(computeFrame({ z, playing: 0, vw: 1280, vh: DESIGN_H, jump: null, announce: '', coarse: false, props }, cap));
        delete got.announce;
        expect(got, `${JSON.stringify(change)} at z = ${z}`).toEqual(theirs);
      }
    }
  });

  it('on a touch device, where the hint reads differently', () => {
    const original = runOriginal({ coarse: true });
    const mine = computeFrame({ z: 0, playing: 0, vw: 1280, vh: DESIGN_H, jump: null, announce: '', coarse: true, props: defaults }, slots());
    expect(mine.hint).toBe(original.vals().hint);
    expect(mine.hint).toBe('drag or pinch to zoom');
  });
});

// ---- motion

type Step =
  | { do: 'frames'; n: number; ms: number }
  | { do: 'rest'; ms: number }
  | { do: 'wheel'; deltaY: number; deltaMode?: number; ctrlKey?: boolean }
  | { do: 'range'; value: string }
  | { do: 'key'; key: string; shiftKey?: boolean }
  | { do: 'out' } | { do: 'in' } | { do: 'home' }
  | { do: 'pick'; i: number }
  | { do: 'down'; id: number; x: number; y: number; type?: string }
  | { do: 'move'; id: number; x: number; y: number }
  | { do: 'up'; id: number };

/** Plays the same events, on the same clock, into the original and into the site's Journey, comparing after every step. */
function play(steps: Step[], opts: { width?: number; reduced?: boolean; props?: Partial<Props> } = {}) {
  const width = opts.width ?? 1280;
  const props = { ...defaults, ...opts.props };
  const original = runOriginal({ width, reduced: opts.reduced, props });
  const o = original.comp;

  let pending: ((ts: number) => void) | null = null;
  let ids = 0;
  const journey = new Journey(
    { raf: (cb) => { pending = cb; return ++ids; }, reduced: !!opts.reduced, coarse: false },
    props,
    () => {},
  );
  journey.resize(width, DESIGN_H);
  const myFrame = (ts: number) => { if (!pending) return false; const cb = pending; pending = null; cb(ts); return true; };

  let now = 1000, compared = 0;
  const trail: number[] = [];
  const compare = (what: string) => {
    expect(journey.z, `${what}: zoom`).toBe(o.getZ());
    expect(journey.zT, `${what}: target`).toBe(o.zT);
    expect(journey.playing, `${what}: playing`).toBe(o.getPlaying());
    expect(withoutRail(journey.frame()), `${what}: frame`).toEqual(original.vals());
    compared++;
  };
  const tick = (ms: number, what: string) => {
    now += ms;
    const a = original.frame(now), b = myFrame(now);
    expect(b, `${what}: both should be animating, or neither`).toBe(a);
    if (a) { compare(what); trail.push(journey.z); }
    return a;
  };
  compare('start');
  steps.forEach((s, n) => {
    const what = `step ${n} (${s.do})`;
    const pointer = (id: number, x: number, y: number, type = 'touch') => ({ pointerType: type, pointerId: id, clientX: x, clientY: y, currentTarget: { setPointerCapture() {} } });
    switch (s.do) {
      case 'frames': for (let i = 0; i < s.n; i++) tick(s.ms, `${what} frame ${i}`); return;
      case 'rest': { let guard = 0; while (tick(s.ms, `${what} frame ${guard}`)) if (++guard > 20000) throw new Error('never came to rest'); return; }
      case 'wheel': { const e = { deltaY: s.deltaY, deltaMode: s.deltaMode ?? 0, ctrlKey: !!s.ctrlKey }; o._h.wheel(e); journey.onWheel(e); break; }
      case 'range': o._h.range({ target: { value: s.value } }); journey.onRange(s.value); break;
      case 'key': { const e = { key: s.key, shiftKey: !!s.shiftKey, preventDefault() {} }; o._h.key(e); journey.onRailKey(e); break; }
      case 'out': o._h.out(); journey.toggle(1); break;
      case 'in': o._h.inn(); journey.toggle(-1); break;
      case 'home': o._h.home(); journey.home(); break;
      case 'pick': o._picks[s.i](); journey.pick(s.i); break;
      case 'down': { const e = pointer(s.id, s.x, s.y, s.type); o._h.pd(e); journey.onPtrDown(e); break; }
      case 'move': { const e = pointer(s.id, s.x, s.y); o._h.pm(e); journey.onPtrMove(e); break; }
      case 'up': { const e = pointer(s.id, 0, 0); o._h.pu(e); journey.onPtrUp(e); break; }
    }
    compare(what);
  });
  return { compared, trail, journey };
}

describe('the motion equals the original, frame by frame', () => {
  it('flying out from Moustique to the edge, slowing at every stop', () => {
    const { trail, journey } = play([{ do: 'out' }, { do: 'rest', ms: 1000 / 60 }]);
    expect(Math.abs(journey.z - ZMAX)).toBeLessThanOrEqual(0.0006);
    expect(trail.length).toBeGreaterThan(2000);
  });

  it('flying in to the proton at 120 frames a second', () => {
    const { journey } = play([{ do: 'in' }, { do: 'rest', ms: 1000 / 120 }]);
    expect(Math.abs(journey.z - ZMIN)).toBeLessThanOrEqual(0.0006);
  });

  it('pausing, resuming and reversing a flight', () => {
    play([
      { do: 'out' }, { do: 'frames', n: 90, ms: 16.7 }, { do: 'out' }, { do: 'frames', n: 20, ms: 16.7 },
      { do: 'in' }, { do: 'frames', n: 200, ms: 16.7 }, { do: 'out' }, { do: 'frames', n: 50, ms: 16.7 },
      { do: 'in' }, { do: 'in' }, { do: 'rest', ms: 16.7 },
    ]);
  });

  it('the wheel: mouse notches, trackpad streams, pinch, and line and page modes', () => {
    const steps: Step[] = [];
    for (let i = 0; i < 12; i++) steps.push({ do: 'wheel', deltaY: 120 }, { do: 'frames', n: 3, ms: 16.7 });
    for (let i = 0; i < 80; i++) steps.push({ do: 'wheel', deltaY: -7.5 - (i % 5) }, { do: 'frames', n: 1, ms: 8.3 });
    for (let i = 0; i < 30; i++) steps.push({ do: 'wheel', deltaY: i % 2 ? 3.2 : -9.1, ctrlKey: true }, { do: 'frames', n: 1, ms: 16.7 });
    steps.push({ do: 'wheel', deltaY: 3, deltaMode: 1 }, { do: 'frames', n: 10, ms: 16.7 }, { do: 'wheel', deltaY: -1, deltaMode: 2 }, { do: 'rest', ms: 16.7 });
    steps.push({ do: 'wheel', deltaY: 1e6 }, { do: 'rest', ms: 16.7 }, { do: 'wheel', deltaY: -1e7 }, { do: 'rest', ms: 16.7 });
    play(steps);
  });

  it('the wheel interrupting a flight, and a flight interrupting a jump', () => {
    play([
      { do: 'out' }, { do: 'frames', n: 60, ms: 16.7 }, { do: 'wheel', deltaY: -240 }, { do: 'frames', n: 30, ms: 16.7 },
      { do: 'pick', i: 3 }, { do: 'frames', n: 25, ms: 16.7 }, { do: 'in' }, { do: 'frames', n: 40, ms: 16.7 },
      { do: 'home' }, { do: 'frames', n: 10, ms: 16.7 }, { do: 'wheel', deltaY: 50 }, { do: 'rest', ms: 16.7 },
    ]);
  });

  it('jumping to every landmark in turn, and back to Moustique', () => {
    const steps: Step[] = [];
    LMS.forEach((_l, i) => steps.push({ do: 'pick', i: (i * 7) % LMS.length }, { do: 'rest', ms: 16.7 }));
    steps.push({ do: 'home' }, { do: 'rest', ms: 16.7 });
    const { journey } = play(steps);
    expect(Math.abs(journey.z)).toBeLessThanOrEqual(0.0006);
  });

  it('the rail: arrow keys, page keys, shift, Home and End, and dragging', () => {
    const steps: Step[] = [];
    for (const key of ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'PageUp', 'PageDown', 'a', 'Enter']) steps.push({ do: 'key', key }, { do: 'frames', n: 12, ms: 16.7 });
    for (const key of ['ArrowUp', 'PageDown']) steps.push({ do: 'key', key, shiftKey: true }, { do: 'frames', n: 12, ms: 16.7 });
    steps.push({ do: 'key', key: 'End' }, { do: 'frames', n: 100, ms: 16.7 }, { do: 'key', key: 'Home' }, { do: 'rest', ms: 16.7 });
    for (const value of ['3.5', '3.62', '4.1', '12', '-2.25', 'nonsense', '99', '-99']) steps.push({ do: 'range', value }, { do: 'frames', n: 6, ms: 16.7 });
    steps.push({ do: 'rest', ms: 16.7 });
    play(steps);
  });

  it('touch: one finger drags, two fingers pinch, a mouse press does nothing', () => {
    const steps: Step[] = [{ do: 'out' }, { do: 'frames', n: 30, ms: 16.7 }, { do: 'down', id: 1, x: 200, y: 400 }];
    for (let i = 1; i <= 40; i++) steps.push({ do: 'move', id: 1, x: 200 + i, y: 400 + i * 6 }, { do: 'frames', n: 1, ms: 16.7 });
    steps.push({ do: 'down', id: 2, x: 300, y: 300 });
    for (let i = 1; i <= 40; i++) steps.push({ do: 'move', id: 2, x: 300 + i * 4, y: 300 - i * 3 }, { do: 'move', id: 1, x: 240 - i * 2, y: 640 + i }, { do: 'frames', n: 1, ms: 16.7 });
    steps.push({ do: 'up', id: 2 }, { do: 'move', id: 1, x: 100, y: 500 }, { do: 'up', id: 1 }, { do: 'move', id: 1, x: 0, y: 0 });
    steps.push({ do: 'down', id: 9, x: 10, y: 10, type: 'mouse' }, { do: 'move', id: 9, x: 10, y: 300 }, { do: 'up', id: 9 }, { do: 'rest', ms: 16.7 });
    play(steps);
  });

  it('uneven frames: a stall, a burst, a background tab', () => {
    play([
      { do: 'pick', i: 0 }, { do: 'frames', n: 5, ms: 16.7 }, { do: 'frames', n: 1, ms: 400 }, { do: 'frames', n: 6, ms: 2 },
      { do: 'frames', n: 3, ms: 0.2 }, { do: 'frames', n: 1, ms: 30000 }, { do: 'rest', ms: 33.4 },
    ]);
  });

  it('with reduced motion, where jumps do not fly', () => {
    const { journey } = play([
      { do: 'pick', i: 0 }, { do: 'pick', i: 25 }, { do: 'key', key: 'End' }, { do: 'home' }, { do: 'out' },
      { do: 'frames', n: 40, ms: 16.7 }, { do: 'wheel', deltaY: 300 }, { do: 'rest', ms: 16.7 },
    ], { reduced: true });
    expect(journey.z).not.toBe(0);
  });

  it('on a phone-width window with a longer cat and a faster flight', () => {
    play([{ do: 'out' }, { do: 'frames', n: 400, ms: 16.7 }, { do: 'pick', i: 20 }, { do: 'rest', ms: 16.7 }],
      { width: 390, props: { moustiqueLengthCm: 58, flySpeed: 3 } });
  });
});
