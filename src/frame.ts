// Everything that is drawn at one instant, as a function of the zoom and the window.
//
// This is the design's renderVals(), ported line for line. The one generalisation: the design
// was drawn on a fixed 820 px tall artboard, and here the artboard height is a parameter (the
// drawing keeps covering the window the way the artboard's "slice" did). With vh = 820 every
// value equals the original's; tests/oracle.test.ts runs the original and checks.
import {
  DESIGN_H, DESIGN_W, GND, HID, ICON_IN, ICON_OUT, ICON_PAUSE, LAB, LMS, OBJ, RAIL_W, RE, SUNHID, SUN_X,
  SUN_Y, T0, ZMAX, ZMIN, capFor, fmtLen, fmtTime, nearest, sig, smooth01, vis, win,
} from './design';
import { railFor } from './rail';

export interface Props {
  moustiqueLengthCm: number;
  flySpeed: number;
  handDrawn: boolean;
  ink: string;
}

export interface CaptionSlot { key: string; t: string; d: string }
/** Two caption slots that crossfade; `on` is the one showing. */
export interface CaptionSlots { a: CaptionSlot; b: CaptionSlot; on: 'a' | 'b' }

export interface FrameInput {
  z: number;
  playing: -1 | 0 | 1;
  /** Window width and height in CSS px. */
  vw: number;
  vh: number;
  /** Where a "jump to" flight is heading, so its caption can show straight away. */
  jump: number | null;
  announce: string;
  coarse: boolean;
  props: Props;
}

type Shown = Record<string, string>;
export interface Frame {
  vb: string;
  pan: string;
  catK: string;
  winT: string;
  pf: string;
  ink: string;
  v: Record<string, Shown>;
  lb: Record<string, Shown>;
  ground: Shown;
  earth: Shown;
  grid: Shown;
  atm: Shown;
  sun: Shown;
  km100: Shown;
  iss: Shown;
  marker: Shown;
  capA: Shown;
  capB: Shown;
  announce: string;
  landmarks: { name: string; top: number; cur: string; fw: string }[];
  needle: string;
  widthStr: string;
  mousStr: string;
  lightStr: string;
  z: number;
  zLabel: string;
  hint: string;
  outLabel: string;
  inLabel: string;
  outIcon: string;
  inIcon: string;
  rail: { tr: string; tk: string; lt: string; ex: string[] };
}

/** Window sizes below these get the design's compact layout: no rail, cat a little higher. */
export const MIN_RAIL_W = 760;
export const MIN_RAIL_H = 560;

export function cmOf(props: Props): { M: number; cm: number } {
  let cm = Number(props.moustiqueLengthCm);
  if (!(cm >= 10 && cm <= 150)) cm = 46;
  return { M: cm / 100, cm };
}

/**
 * The offset of the whole drawing at a zoom, as numbers: the same arithmetic as `pan` in
 * computeFrame below, before rounding. The renderer uses it to know which part of a layer
 * is at the middle of the view at zooms other than the current one.
 */
export function panAt(z: number, props: Props): [number, number] {
  const k = cmOf(props).cm / 46 * (1 - smooth01((-0.25 - z) / 0.6)) * Math.pow(10, -z);
  return [-201.4 * k, -103.1 * k];
}

const GONE = { y: '0', o: '0', d: 'none' };
const GONE_CIRCLE = { cy: '0', r: '0', o: '0', d: 'none' };
const GONE_LABEL = { x: '0', y: '0', o: '0', d: 'none' };

export function computeFrame(s: FrameInput, C: CaptionSlots): Frame {
  const z = s.z;
  const playing = s.playing;
  const { M, cm } = cmOf(s.props);
  const Wpx = s.vw, Hpx = s.vh;
  const desk = Wpx >= MIN_RAIL_W && Hpx >= MIN_RAIL_H;
  const sc = Math.max(Wpx / DESIGN_W, Hpx / DESIGN_H);
  const vwu = Wpx / sc, vhu = Hpx / sc;
  const ox = (Wpx - (desk ? RAIL_W : 0)) / 2, oy = (desk ? 0.36 : 0.3) * Hpx;
  const vb = (-ox / sc - (DESIGN_W - vwu) / 2).toFixed(2) + ' ' + (-oy / sc - (DESIGN_H - vhu) / 2).toFixed(2) + ' ' + DESIGN_W + ' ' + DESIGN_H;
  const kc = cm / 46;
  const ksc = Math.pow(10, -z);
  const tp = smooth01((-0.25 - z) / 0.6);
  const pan = 'translate(' + (-201.4 * kc * (1 - tp) * ksc).toFixed(2) + ' ' + (-103.1 * kc * (1 - tp) * ksc).toFixed(2) + ')';
  const catK = 'scale(' + kc.toFixed(4) + ')';
  const winT = 'translate(0 ' + (116.0 * kc - 192.46).toFixed(2) + ') scale(1.4 1)';

  const v: Record<string, Shown> = {};
  for (const n in OBJ) {
    const p = OBJ[n];
    const o = win(z, p[1], p[2], p[3], p[4]);
    v[n] = vis(o) ? { t: 'scale(' + Math.pow(10, p[0] - z).toPrecision(6) + ')', o: o.toFixed(3), d: 'inline' } : HID;
  }

  const U = 1280 / Math.pow(10, z);
  const og = win(z, 0.8, 5.0, 0.1, 0.2);
  const ground = vis(og) ? { y: (GND * U).toFixed(2), o: og.toFixed(3), d: 'inline' } : GONE;
  const ecy = (GND + RE) * U, er = RE * U;
  const oe = win(z, 4.8, 10.3, 0.2, 0.3);
  const earth = vis(oe) ? { cy: ecy.toFixed(3), r: er.toFixed(3), o: oe.toFixed(3), d: 'inline' } : GONE_CIRCLE;
  const ogr = win(z, 7.0, 9.8, 0.4, 0.3);
  const grid = vis(ogr) ? { t: 'translate(0 ' + ecy.toFixed(3) + ') scale(' + (er / 100).toPrecision(6) + ')', o: ogr.toFixed(3), d: 'inline' } : HID;
  const oa = win(z, 5.3, 8.4, 0.3, 0.3);
  const atm = vis(oa) ? { cy: ecy.toFixed(3), r: ((RE + 1e5) * U).toFixed(3), o: oa.toFixed(3), d: 'inline' } : GONE_CIRCLE;

  const os = win(z, 10.2, 16.2, 0.3, 0.35);
  let sun: Shown = SUNHID;
  if (vis(os)) {
    const km = smooth01((z - 12.4) / 1.2);
    sun = {
      t: 'translate(' + (SUN_X * U).toFixed(2) + ' ' + (SUN_Y * U).toFixed(2) + ')',
      o: os.toFixed(3), d: 'inline',
      rs: 'scale(' + Math.max(0.001, 1 - km).toFixed(4) + ')', ro: (1 - km).toFixed(3),
      r: (6 - 3.4 * km).toFixed(2), wo: (1 - km).toFixed(3), fo: km.toFixed(3),
      lx: (19 - 5 * km).toFixed(1), ly: (4 + 14 * km).toFixed(1), lo: win(z, 10.2, 15.9, 0.3, 0.3).toFixed(3),
    };
  }
  const ok = win(z, 5.55, 6.45, 0.25, 0.25);
  const km100 = vis(ok) ? { y: (-1e5 * U - 7).toFixed(1), o: ok.toFixed(3), d: 'inline' } : GONE;
  const oi = win(z, 6.15, 7.2, 0.25, 0.3);
  const iss = vis(oi) ? { t: 'translate(0 ' + (-4e5 * U).toFixed(2) + ')', o: oi.toFixed(3), d: 'inline' } : HID;

  const om = win(z, 0.45, 28.2, 0.35, 0.1);
  let marker: Shown = { o: '0', d: 'none', cx: '0', cy: '0', r: '0', f: '0', lo: '0', leader: 'M0 0' };
  if (vis(om)) {
    const ks = Math.pow(10, -z);
    const rt = 360 * kc * ks;
    const mr = Math.max(rt, 2.6);
    const mcx = 201.4 * kc * ks, mcy = 140 * kc * ks;
    const e45 = mr * 0.7071;
    marker = {
      o: om.toFixed(3), d: 'inline',
      cx: mcx.toFixed(2), cy: mcy.toFixed(2), r: mr.toFixed(2),
      f: smooth01((5 - rt) / 3).toFixed(3),
      lo: win(z, 1.9, 28.2, 0.3, 0.1).toFixed(3),
      leader: 'M' + (mcx + e45).toFixed(2) + ' ' + (mcy - e45).toFixed(2) + 'L36 -56H44',
    };
  }

  const lb: Record<string, Shown> = {};
  for (const n in LAB) {
    const p = LAB[n];
    const o = win(z, p[5], p[6], 0.25, 0.25);
    if (vis(o)) {
      const kk = Math.pow(10, p[0] - z);
      lb[n] = { x: (p[1] * kk + p[3]).toFixed(1), y: (p[2] * kk + p[4]).toFixed(1), o: o.toFixed(3), d: 'inline' };
    } else {
      lb[n] = GONE_LABEL;
    }
  }

  const nr = nearest(z);
  const cur = nr.d < 0.55 ? nr.i : -1;
  const want = capFor(s.jump !== null ? s.jump : z, M, cm);
  const live = C[C.on];
  if (want) {
    if (want.key === live.key) {
      live.t = want.t;
      live.d = want.d;
    } else {
      const off = C.on === 'a' ? 'b' : 'a';
      C[off] = { key: want.key, t: want.t, d: want.d };
      C.on = off;
    }
  }
  const capA = { t: C.a.t, d: C.a.d, o: C.on === 'a' ? '1' : '0', h: C.on === 'a' ? 'false' : 'true' };
  const capB = { t: C.b.t, d: C.b.d, o: C.on === 'b' ? '1' : '0', h: C.on === 'b' ? 'false' : 'true' };

  const rail = railFor(Hpx);
  const landmarks = LMS.map((l, j) => {
    const on = j === cur;
    return { name: l.name, top: rail.tops[j], cur: on ? 'true' : 'false', fw: on ? '600' : '400' };
  });
  const ny = T0 + (ZMAX - z) / (ZMAX - ZMIN) * rail.th;
  const stageU = vwu - (desk ? RAIL_W / sc : 0);
  const Wm = Math.pow(10, z) * stageU / 1280;
  const widthStr = fmtLen(Wm);
  const nm = Wm / M;
  const lightStr = fmtTime(Wm / 299792458);
  const mousStr = nm >= 1 ? sig(nm) + (nm < 1.005 ? ' Moustique' : ' Moustiques') : sig(1 / nm) + ' of these span one Moustique';

  return {
    vb, km100, iss, pan, catK, winT, v, ground, earth, grid, atm, sun, marker, lb,
    pf: s.props.handDrawn ? 'url(#pencilB)' : 'none',
    ink: s.props.ink || '#141414',
    capA, capB,
    announce: s.announce || '',
    landmarks,
    needle: 'translate(0 ' + ny.toFixed(1) + ')',
    widthStr, mousStr, lightStr,
    z, zLabel: widthStr + ' across' + (cur >= 0 ? ', ' + LMS[cur].name : ''),
    hint: s.coarse ? 'drag or pinch to zoom' : 'scroll or pinch to zoom',
    outLabel: playing === 1 ? 'Pause' : 'Fly out',
    inLabel: playing === -1 ? 'Pause' : 'Fly in',
    outIcon: playing === 1 ? ICON_PAUSE : ICON_OUT,
    inIcon: playing === -1 ? ICON_PAUSE : ICON_IN,
    rail,
  };
}
