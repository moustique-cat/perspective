// What a frame is, as handed to the chip. The same plan drives both backends.
import type { Level } from './scene';

/** left, top, right, bottom in device pixels */
export type Box = [number, number, number, number];
/** Pixels per layer unit, then the offset in pixels: screen = point * k + (x, y). */
export type Placement = [number, number, number];

export const C_MARKS = 0, C_FILL = 1, C_CIRCLE = 2, C_OVER = 3;

export type Command =
  | {
    op: 0;
    level: Uploaded;
    /** Which batch of the level, and how many of its records (a prefix: the ones on screen). */
    batch: number;
    count: number;
    at: Placement;
    /** Gather the marks into one shape first, then lay it down with this opacity. */
    gather: boolean;
    opacity: number;
    /** Dash lengths on and off, device px. */
    dash: [number, number] | null;
  }
  | { op: 1; level: Uploaded; first: number; count: number; at: Placement }
  | {
    op: 2;
    /** The part of the window the circle can touch. */
    box: Box;
    /** The point of the circle nearest the window, and the outward direction there. */
    near: [number, number, number, number];
    radius: number;
    /** Index into the width table. */
    width: number;
    filled: boolean;
    /** Dash lengths on and off, and the arc length at the nearest point: device px. */
    dash: [number, number, number] | null;
    opacity: number;
  }
  | { op: 3; group: number; opacity: number; box: Box };

export interface FramePlan {
  /** Ink colour, 0 to 1. */
  ink: [number, number, number];
  /** Layers in mid-fade: each is drawn on its own first, then laid over the picture as one. */
  groups: { box: Box; commands: Command[] }[];
  /** The picture, in paint order. */
  commands: Command[];
}

/** A level as it lives on the chip. */
export interface Uploaded {
  readonly level: Level;
  /** Bytes held on the chip. */
  readonly bytes: number;
}

export interface Backend {
  readonly kind: 'webgl2' | 'webgpu';
  readonly canvas: HTMLCanvasElement;
  /** A description of the chip, for reports. */
  readonly chip: string;
  /** Resolves when the shaders are compiled and the backend can draw without stalling. */
  ready(): Promise<void>;
  /** Size of the picture in device pixels. */
  resize(width: number, height: number): void;
  /** Half stroke widths in device pixels, one per width index (at most eight). */
  setWidths(half: number[]): void;
  upload(level: Level): Uploaded;
  release(uploaded: Uploaded): void;
  draw(plan: FramePlan): void;
  /** The picture just drawn, top row first, four bytes per pixel. For tests. */
  read(): Promise<Uint8Array>;
  /** Called if the chip is taken away (the page was in the background, the driver restarted). */
  onLost(callback: () => void): void;
  destroy(): void;
}
