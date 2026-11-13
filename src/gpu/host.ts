// What the page hands the renderer when it arrives. Types only: the renderer is a separate
// file fetched after the page is zoomable, and shares no code with the page's own script.
import type { Frame, Props } from '../frame';

/** A part of the drawing that is placed by one scale and one offset per frame. */
export interface SheetInfo {
  /** The zooms between which it can be on screen. */
  from: number;
  to: number;
  /** Its scale (drawing units per unit of its own) at a zoom. */
  scale(z: number): number;
}

export interface Host {
  /** The page's root element and the SVG drawing inside it. */
  root: HTMLElement;
  svg: SVGSVGElement;
  props: Props;
  /** prefers-reduced-motion */
  reduced: boolean;
  /** Where the zoom is and where it is heading; the window size in CSS px. */
  journey: { readonly z: number; readonly zT: number; readonly playing: number; readonly vw: number; readonly vh: number; render(): void };
  /** Every layer by name, plus "grid" and "ground". */
  sheets: Record<string, SheetInfo>;
  /** The offset of the whole drawing at a zoom, in drawing units: the design's pan. */
  panAt(z: number): [number, number];
  /** Hands over every frame, after it has been written to the page. */
  onFrame(callback: ((frame: Frame) => void) | null): void;
  /** The frame on the page now. */
  frame(): Frame | null;
  /** What the frame would be at another zoom, everything else as it is. */
  frameAt(z: number): Frame;
  /** Stops writing values into the page under this element (null: resume everywhere). */
  mute(element: Element | null): void;
}

/** What a renderer file exports. Resolves to a short description of what took over, or null if it did not. */
export type Start = (host: Host, options: StartOptions) => Promise<Running | null>;

export interface StartOptions {
  /** Draw even with software rendering (tests); normally a device without a chip stays on the SVG. */
  force: boolean;
  /** A canvas whose context the page already made while finding out what the device can do. */
  canvas?: HTMLCanvasElement;
  /** The WebGPU adapter the page already asked for. */
  adapter?: unknown;
  /**
   * Departures from the design, on purpose. For the tests that check the comparison with the
   * SVG can tell: every stroke wider by a factor, or the whole picture moved by a fraction of
   * a pixel. For the speed report: this many extra marks on screen at every zoom.
   */
  fault?: { wider?: number; moved?: number; extra?: number };
}

export interface Running {
  kind: 'webgl2' | 'webgpu';
  chip: string;
  /** Marks and draw calls in the last frame. */
  stats: { marks: number; calls: number; groups: number; levels: number; bytes: number };
  /** The picture as drawn by the chip, as a PNG data address. For tests. */
  snapshot(): Promise<string>;
  /** Resolves when no level is being waited for at the current zoom. */
  settled(): Promise<void>;
  /** Resolves when every level of every layer has been built: nothing is left to arrive. */
  idle(): Promise<void>;
  /** Resolves when the SVG drawing has been put away and the picture on screen is the renderer's alone. */
  handed: Promise<void>;
  /** Resolves if the chip is taken away: the renderer has then put the SVG drawing back and is gone. */
  gone: Promise<void>;
  stop(): void;
}
