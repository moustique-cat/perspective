// Building levels away from the page's own thread.
//
// Turning a layer into records takes a few milliseconds: nothing, unless it lands in the
// middle of a flight. So it happens in a worker. The page sends the drawing once, as the
// path data it read out of the SVG, then asks for levels one at a time, nearest the traveller
// first; each comes back as buffers ready for the chip. Where a worker cannot be started,
// the same code runs on the page between frames.
import { circle, parsePath, type Matrix } from './path';
import { boundsOf, buildLevel, type ElementSource, type LayerSource, type Level } from './scene';

/** An element as read from the page: its path data still text. */
export interface RawElement {
  d: string | null;
  /** cx, cy, r of a <circle> */
  circle: [number, number, number] | null;
  matrix: Matrix;
  width: number;
  opacity: number;
  dash: [number, number] | null;
  fill: 0 | 1 | 2;
}
export interface RawSheet { name: string; elements: RawElement[] }

export type Request =
  | { t: 0; sheets: RawSheet[]; widths: number[] }
  | { t: 1; id: number; sheet: number; tolerance: number; origin: [number, number]; radius: number };
/** A level, with the box around all of its sheet's marks (in the sheet's own units). */
export interface Reply { id: number; level: Level | null; box?: [number, number, number, number]; error?: string }

export function parseSheet(raw: RawSheet): LayerSource {
  return {
    name: raw.name,
    elements: raw.elements.map((e): ElementSource => ({
      paths: e.circle ? [circle(e.circle[0], e.circle[1], e.circle[2])] : parsePath(e.d || ''),
      matrix: e.matrix, width: e.width, opacity: e.opacity, dash: e.dash, fill: e.fill,
    })),
  };
}

/** Answers requests; lives in the worker, or on the page where there is none. */
export function levelBuilder(): (request: Request) => { reply: Reply; transfer: ArrayBuffer[] } | null {
  let sheets: (LayerSource | null)[] = [], raw: RawSheet[] = [], widths: number[] = [];
  const boxes: [number, number, number, number][] = [];
  return (request) => {
    if (request.t === 0) {
      raw = request.sheets;
      sheets = raw.map(() => null);
      widths = request.widths;
      return null;
    }
    try {
      // a sheet is parsed the first time one of its levels is wanted
      const sheet = sheets[request.sheet] || (sheets[request.sheet] = parseSheet(raw[request.sheet]));
      const level = buildLevel(sheet, { tolerance: request.tolerance, origin: request.origin, radius: request.radius, widths });
      const transfer: ArrayBuffer[] = [level.records, level.fills.buffer as ArrayBuffer];
      for (const b of level.batches) if (b.reach) transfer.push(b.reach.buffer as ArrayBuffer);
      const box = boxes[request.sheet] || (boxes[request.sheet] = boundsOf(sheet));
      return { reply: { id: request.id, level, box }, transfer };
    } catch (e) {
      return { reply: { id: request.id, level: null, error: String(e) }, transfer: [] };
    }
  };
}
