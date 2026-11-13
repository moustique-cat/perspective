// The motion: where the zoom is, where it is heading, and how it gets there.
//
// A port of the design component's methods (tick, onWheel, onRange, onRailKey, pointer
// handlers, toggle, flyTo), kept in the same shape and with the same constants so the feel is
// the original's. tests/oracle.test.ts drives the original and this class with the same
// events and clock and compares them step by step.
import { LMS, Z0, ZMAX, ZMIN, capFor, dwell } from './design';
import { cmOf, computeFrame, type CaptionSlots, type Frame, type Props } from './frame';

export interface Env {
  raf(cb: (ts: number) => void): number;
  /** prefers-reduced-motion: reduce */
  reduced: boolean;
  /** pointer: coarse */
  coarse: boolean;
}

export interface WheelLike { deltaY: number; deltaMode: number; ctrlKey: boolean }
export interface KeyLike { key: string; shiftKey: boolean; preventDefault(): void }
export interface PointerLike { pointerType: string; pointerId: number; clientX: number; clientY: number }

export class Journey {
  z = Z0;
  playing: -1 | 0 | 1 = 0;
  announce = '';
  vw = 0;
  vh = 0;

  /** Target zoom; `z` eases towards it. */
  zT = Z0;
  jump: number | null = null;
  private raf = 0;
  private last = 0;
  private said = '';
  private ptrs: Record<number, { x: number; y: number }> = {};
  private cap: CaptionSlots = { a: { key: '', t: '', d: '' }, b: { key: '', t: '', d: '' }, on: 'a' };
  private readonly onTick = (ts: number) => this.tick(ts);

  constructor(
    private readonly env: Env,
    public props: Props,
    private readonly paint: (frame: Frame) => void,
  ) {}

  /** Compute the current frame. Like the original's renderVals, this advances the caption crossfade. */
  frame(): Frame {
    return computeFrame({
      z: this.z, playing: this.playing, vw: this.vw, vh: this.vh, jump: this.jump,
      announce: this.announce, coarse: this.env.coarse, props: this.props,
    }, this.cap);
  }

  render(): void {
    this.paint(this.frame());
  }

  resize(w: number, h: number): void {
    if (w > 0 && h > 0 && (this.vw !== w || this.vh !== h)) {
      this.vw = w;
      this.vh = h;
      this.render();
    }
  }

  private speed(): number {
    const v = Number(this.props.flySpeed);
    return v > 0 ? v : 0.8;
  }

  private clampZ(z: number): number {
    return z < ZMIN ? ZMIN : (z > ZMAX ? ZMAX : z);
  }

  private kick(): void {
    if (!this.raf) {
      this.last = 0;
      this.raf = this.env.raf(this.onTick);
    }
  }

  private stopPlaying(): void {
    if (this.playing) {
      this.playing = 0;
      this.render();
    }
  }

  tick(ts: number): void {
    this.raf = 0;
    let z = this.z;
    let playing = this.playing;
    const dt = this.last ? Math.min(0.05, Math.max(0.001, (ts - this.last) / 1000)) : 1 / 60;
    this.last = ts;
    if (playing) {
      this.zT = this.clampZ(this.zT + playing * this.speed() * dwell(this.zT) * dt);
      if (this.zT >= ZMAX || this.zT <= ZMIN) playing = 0;
    }
    const d = this.zT - z;
    const ad = Math.abs(d);
    const step = Math.min(ad * Math.min(1, dt * 7), 10 * dt);
    z = ad < 0.0006 ? this.zT : z + (d > 0 ? step : -step);
    const moving = playing !== 0 || Math.abs(this.zT - z) > 0.0006;
    if (!moving) this.jump = null;
    this.z = z;
    this.playing = playing;
    if (!moving || playing) {
      const mc = cmOf(this.props);
      const c = capFor(z, mc.M, mc.cm);
      if (c && c.key !== this.said) {
        this.said = c.key;
        this.announce = c.t + '. ' + c.d;
      }
    }
    this.render();
    if (moving) {
      this.raf = this.env.raf(this.onTick);
    } else {
      this.last = 0;
    }
  }

  onWheel(e: WheelLike): void {
    let dy = e.deltaY || 0;
    if (e.deltaMode === 1) dy *= 33; else if (e.deltaMode === 2) dy *= 600;
    const f = e.ctrlKey ? 0.012 : 0.0022;
    this.zT = this.clampZ(this.zT + dy * f);
    this.jump = null;
    this.stopPlaying();
    this.kick();
  }

  onRange(value: string): void {
    const val = parseFloat(value);
    if (!isFinite(val)) return;
    this.zT = this.clampZ(val);
    this.jump = null;
    this.stopPlaying();
    this.kick();
  }

  onRailKey(e: KeyLike): void {
    const k = e.key;
    let dz = 0;
    if (k === 'ArrowUp' || k === 'ArrowRight') dz = 0.25;
    else if (k === 'ArrowDown' || k === 'ArrowLeft') dz = -0.25;
    else if (k === 'PageUp') dz = 1;
    else if (k === 'PageDown') dz = -1;
    else if (k === 'Home' || k === 'End') {
      e.preventDefault();
      this.flyTo(k === 'Home' ? ZMIN : ZMAX);
      return;
    } else {
      return;
    }
    e.preventDefault();
    if (e.shiftKey) dz *= 4;
    this.zT = this.clampZ(this.zT + dz);
    this.jump = null;
    this.stopPlaying();
    this.kick();
  }

  /** Touch and pen only: one finger drags the zoom, two fingers pinch it. The mouse uses the wheel. */
  onPtrDown(e: PointerLike): boolean {
    if (e.pointerType === 'mouse') return false;
    this.ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
    this.jump = null;
    this.stopPlaying();
    return true;
  }

  onPtrMove(e: PointerLike): void {
    const p = this.ptrs[e.pointerId];
    if (!p) return;
    const ids = Object.keys(this.ptrs);
    if (ids.length >= 2) {
      const a = this.ptrs[+ids[0]], b = this.ptrs[+ids[1]];
      const d0 = Math.hypot(a.x - b.x, a.y - b.y);
      p.x = e.clientX;
      p.y = e.clientY;
      const d1 = Math.hypot(a.x - b.x, a.y - b.y);
      if (d0 > 8 && d1 > 8) this.zT = this.clampZ(this.zT - Math.log(d1 / d0) / Math.LN10);
    } else {
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      this.zT = this.clampZ(this.zT - dy * 0.006);
    }
    this.kick();
  }

  onPtrUp(e: PointerLike): void {
    delete this.ptrs[e.pointerId];
  }

  /** True while a finger is down, so a browser that also reports the pinch separately can be ignored. */
  get touching(): boolean {
    return Object.keys(this.ptrs).length > 0;
  }

  /**
   * Trackpad pinch as Safari reports it: a scale ratio since the last report. Not in the
   * design (its tool had no Safari gesture events); same maths as its two-finger pinch.
   */
  onPinch(ratio: number): void {
    if (!(ratio > 0) || !isFinite(ratio)) return;
    this.zT = this.clampZ(this.zT - Math.log(ratio) / Math.LN10);
    this.jump = null;
    this.stopPlaying();
    this.kick();
  }

  toggle(dir: -1 | 1): void {
    const next = this.playing === dir ? 0 : dir;
    this.zT = this.z;
    this.jump = null;
    this.playing = next;
    this.render();
    this.kick();
  }

  flyTo(zt: number): void {
    this.zT = this.clampZ(zt);
    if (this.env.reduced) {
      this.jump = null;
      const mc = cmOf(this.props);
      const c = capFor(this.zT, mc.M, mc.cm);
      this.z = this.zT;
      this.playing = 0;
      if (c) {
        this.said = c.key;
        this.announce = c.t + '. ' + c.d;
      }
      this.render();
      return;
    }
    this.jump = this.zT;
    this.playing = 0;
    this.render();
    this.kick();
  }

  home(): void {
    this.flyTo(Z0);
  }

  pick(index: number): void {
    this.flyTo(LMS[index].z);
  }

  /** Go straight to a zoom, with no flight. For tests and tools. */
  setZ(z: number): void {
    this.zT = this.clampZ(z);
    this.jump = null;
    this.z = this.zT;
    this.playing = 0;
    this.render();
  }
}
