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
  stop(): void;
}
