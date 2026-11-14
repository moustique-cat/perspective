// The design, turned into records for the chip.
import { describe, expect, it } from 'vitest';
import { OBJ } from '../src/generated/core.js';
import { B_FILL, B_INK, B_UNION, RECORD_BYTES, boundsOf, buildLevel, fadesInPlace, within } from '../src/gpu/scene';
import { designLayers } from './gpu-source';

const layers = designLayers();
const WIDTHS = [1.25, 0.85, 0.8, 0.9, 2, 1.4, 3.4, 5.5];

describe('the design as records', () => {
  it('finds all 33 layers and their elements', () => {
    expect(layers.map((l) => l.name).sort()).toEqual(Object.keys(OBJ).sort());
    for (const l of layers) expect(l.elements.length, l.name).toBeGreaterThan(0);
    const all = layers.flatMap((l) => l.elements);
    expect(all.filter((e) => e.fill === 1)).toHaveLength(36);
    expect(all.filter((e) => e.fill === 2)).toHaveLength(1);
    expect(all.filter((e) => e.dash)).toHaveLength(12);
  });

  it('census: records per layer and level', () => {
    const t0 = performance.now();
    let records = 0, levels = 0, bytes = 0, slowest = 0;
    const lines: string[] = [];
    for (const l of layers) {
      const p = (OBJ as Record<string, number[]>)[l.name];
      // device px per layer unit, from the layer's smallest scale on a small 1x window to its largest on a dense 4K one
      const lo = Math.floor(Math.log2(Math.pow(10, p[0] - p[2]) * 1)), hi = Math.floor(Math.log2(Math.pow(10, p[0] - p[1]) * 6));
      const counts: string[] = [];
      for (let e = lo; e <= hi; e++) {
        const s = performance.now();
        const level = buildLevel(l, { tolerance: 0.02 / Math.pow(2, e + 1), origin: [0, 0], radius: 3600 / Math.pow(2, e), widths: WIDTHS });
        slowest = Math.max(slowest, performance.now() - s);
        records += level.count; levels++; bytes += level.count * RECORD_BYTES + level.fills.byteLength;
        counts.push(String(level.count));
      }
      const b = boundsOf(l);
      lines.push(`${l.name.padEnd(9)} e ${lo}..${hi}: ${counts.join(' ')}   box ${b.map((n) => n.toFixed(0)).join(',')}`);
    }
    console.log(lines.join('\n'));
    console.log(`  ${levels} levels, ${records} records, ${(bytes / 1048576).toFixed(1)} MB, built in ${(performance.now() - t0).toFixed(0)} ms (slowest level ${slowest.toFixed(1)} ms)`);
    expect(records).toBeGreaterThan(0);
  });

  it('a level keeps paint order around fills and sorts each batch by distance', () => {
    const cat = layers.find((l) => l.name === 'cat')!;
    const level = buildLevel(cat, { tolerance: 0.01, origin: [201.4, 103.1], radius: Infinity, widths: WIDTHS });
    expect(level.batches.filter((b) => b.kind === B_FILL)).toHaveLength(3);
    expect(level.batches[0].kind).toBe(B_FILL);
    expect(fadesInPlace(level)).toBe(false);
    let at = 0;
    for (const b of level.batches) {
      if (b.kind === B_FILL) continue;
      expect(b.first).toBe(at);
      at += b.count;
      for (let i = 1; i < b.count; i++) expect(b.reach![i]).toBeGreaterThanOrEqual(b.reach![i - 1]);
      expect(within(b, -1)).toBe(0);
      expect(within(b, Infinity)).toBe(b.count);
      expect(b.kind === B_INK || b.kind === B_UNION).toBe(true);
    }
    expect(at).toBe(level.count);
  });
});
