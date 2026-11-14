// When and at what scale each part of the drawing is on screen, for the renderer.
//
// The layers come from the design's own table. The Earth's grid and the ground line are
// placed by computeFrame() with literal numbers; they are repeated here, and
// tests/sheets.test.ts checks them against what computeFrame() does.
import { OBJ, RE } from './design';
import type { SheetInfo } from './gpu/host';

export function sheets(): Record<string, SheetInfo> {
  const out: Record<string, SheetInfo> = {
    grid: { from: 7.0, to: 9.8, scale: (z) => RE * 1280 / Math.pow(10, z) / 100 },
    ground: { from: 0.8, to: 5.0, scale: () => 1 },
  };
  for (const name in OBJ) {
    const p = OBJ[name];
    out[name] = { from: p[1], to: p[2], scale: (z) => Math.pow(10, p[0] - z) };
  }
  return out;
}
