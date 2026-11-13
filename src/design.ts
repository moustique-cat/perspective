// Typed access to the original design's own data, captions and helper functions.
// The code behind these names is the design's script, copied verbatim at build time
// (see scripts/extract-design.mjs); nothing here re-implements it.
import * as raw from './generated/core.js';

export interface Landmark {
  name: string;
  z: number;
  d: (M: number, cm: number) => string;
}
export interface Caption {
  key: string;
  t: string;
  d: string;
}
/** [authored zoom, visible from, visible to, fade-in width, fade-out width] */
export type LayerWindow = [number, number, number, number, number];
/** [authored zoom, x, y, dx, dy, visible from, visible to] */
export type LabelSpec = [number, number, number, number, number, number, number];

interface Core {
  ZMIN: number;
  ZMAX: number;
  Z0: number;
  RAIL_W: number;
  T0: number;
  TH: number;
  RAIL_TOPS: number[];
  HID: { t: string; o: string; d: string };
  SUNHID: Record<string, string>;
  OBJ: Record<string, LayerWindow>;
  LAB: Record<string, LabelSpec>;
  SUN_X: number;
  SUN_Y: number;
  RE: number;
  GND: number;
  ICON_OUT: string;
  ICON_IN: string;
  ICON_PAUSE: string;
  LMS: Landmark[];
  smooth01(x: number): number;
  win(z: number, a: number, b: number, fa: number, fb: number): number;
  vis(o: number): boolean;
  sig(x: number): string;
  fmtLen(m: number): string;
  fmtTime(t: number): string;
  nearest(z: number): { i: number; d: number };
  capFor(z: number, M: number, cm: number): Caption | null;
  dwell(z: number): number;
}

const core = raw as unknown as Core;

export const {
  ZMIN, ZMAX, Z0, RAIL_W, T0, TH, RAIL_TOPS, HID, SUNHID, OBJ, LAB, SUN_X, SUN_Y, RE, GND,
  ICON_OUT, ICON_IN, ICON_PAUSE, LMS, smooth01, win, vis, sig, fmtLen, fmtTime, nearest, capFor, dwell,
} = core;

/** The artboard the design was drawn on. At this window size the site must match it exactly. */
export const DESIGN_W = 1280;
export const DESIGN_H = 820;
