// What the renderer is told about when and where each part of the drawing is on screen
// (src/sheets.ts, panAt in src/frame.ts) against what computeFrame() actually writes.
import { describe, expect, it } from 'vitest';
import { OBJ, ZMAX, ZMIN } from '../src/design';
import { computeFrame, panAt, type CaptionSlots, type Props } from '../src/frame';
import { props as designProps } from '../src/generated/page.js';
import { sheets } from '../src/sheets';

const slots = (): CaptionSlots => ({ a: { key: '', t: '', d: '' }, b: { key: '', t: '', d: '' }, on: 'a' });
const frameAt = (z: number, props: Props) => computeFrame({ z, playing: 0, vw: 1280, vh: 820, jump: null, announce: '', coarse: false, props }, slots());
const zooms: number[] = [];
for (let z = ZMIN; z <= ZMAX; z += 0.01) zooms.push(Number(z.toFixed(2)));

describe('what the renderer is told about the drawing', () => {
  const info = sheets();

  it('knows every layer, the grid and the ground', () => {
    expect(Object.keys(info).sort()).toEqual([...Object.keys(OBJ), 'grid', 'ground'].sort());
  });

  it('each part is on screen only between its two zooms, and at the scale given', () => {
    for (const props of [designProps as Props, { ...(designProps as Props), moustiqueLengthCm: 60 }]) {
      for (const z of zooms) {
        const f = frameAt(z, props);
        const shown: Record<string, { d: string; scale: number }> = {
          grid: { d: f.grid.d, scale: f.grid.d === 'none' ? 0 : parseFloat(f.grid.t.slice(f.grid.t.indexOf(') scale(') + 8)) },
          ground: { d: f.ground.d, scale: 1 },
        };
        for (const name in OBJ) shown[name] = { d: f.v[name].d, scale: f.v[name].d === 'none' ? 0 : parseFloat(f.v[name].t.slice(6)) };
        for (const name in shown) {
          const s = info[name];
          if (shown[name].d === 'none') continue;
          expect(z, `${name} is on screen at ${z}`).toBeGreaterThanOrEqual(s.from);
          expect(z, `${name} is on screen at ${z}`).toBeLessThanOrEqual(s.to);
          // the page writes six significant digits
          expect(Math.abs(s.scale(z) / shown[name].scale - 1), `${name} at ${z}`).toBeLessThan(1e-5);
        }
      }
    }
  });

  it('each part does appear within a hundredth of a decade of both ends of its range', () => {
    for (const name in info) {
      const s = info[name];
      for (const z of [s.from + 0.01, Math.min(ZMAX, s.to - 0.01)]) {
        const f = frameAt(z, designProps as Props);
        const d = name === 'grid' ? f.grid.d : name === 'ground' ? f.ground.d : f.v[name].d;
        expect(d, `${name} at ${z}`).toBe('inline');
      }
    }
  });

  it('the offset of the drawing is the one the page writes', () => {
    for (const props of [designProps as Props, { ...(designProps as Props), moustiqueLengthCm: 60 }]) {
      for (const z of zooms) {
        const [x, y] = panAt(z, props);
        expect(frameAt(z, props).pan).toBe(`translate(${x.toFixed(2)} ${y.toFixed(2)})`);
      }
    }
  });
});
