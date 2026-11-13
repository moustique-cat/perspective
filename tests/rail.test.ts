// The rail is the one part of the page whose coordinates the site computes for itself, so that
// it can follow the window height. At the design's height it must reproduce the design's own
// literal coordinates, character for character.
import { describe, expect, it } from 'vitest';
import { LMS, RAIL_TOPS, TH } from '../src/generated/core.js';
import { originalRail } from '../src/generated/page.js';
import { MIN_RAIL_H } from '../src/frame';
import { railFor } from '../src/rail';

describe('the rail at the design height (820 px)', () => {
  const rail = railFor(820);
  it('has the original track', () => {
    expect(rail.th).toBe(TH);
    expect(rail.tr).toBe(originalRail.tr);
  });
  it('has the original power-of-ten ticks', () => {
    expect(rail.tk).toBe(originalRail.tk);
  });
  it('has the original landmark ticks and leader lines', () => {
    expect(rail.lt).toBe(originalRail.lt);
  });
  it('has the original exponent positions', () => {
    expect(rail.ex).toEqual(originalRail.ex);
    expect(originalRail.exText).toEqual(['10⁻¹⁵', '10⁻¹⁰', '10⁻⁵', '10⁰', '10⁵', '10¹⁰', '10¹⁵', '10²⁰', '10²⁵']);
  });
  it('puts every landmark button where the original does', () => {
    expect(rail.tops).toEqual(RAIL_TOPS);
  });
});

describe('the rail at other heights', () => {
  for (const H of [MIN_RAIL_H, 600, 720, 768, 819, 821, 900, 982, 1080, 1200, 1440, 2160]) {
    it(`fits a ${H} px tall window`, () => {
      const rail = railFor(H);
      expect(rail.tops).toHaveLength(LMS.length);
      for (let i = 1; i < rail.tops.length; i++) {
        // buttons are 17 px tall and positions are rounded to a tenth
        expect(rail.tops[i] - rail.tops[i - 1], `landmarks ${i - 1} and ${i} overlap`).toBeGreaterThanOrEqual(17 - 0.11);
      }
      expect(rail.tops[0]).toBeGreaterThanOrEqual(0);
      expect(rail.tops[rail.tops.length - 1] + 17).toBeLessThanOrEqual(H);
    });
  }
});
