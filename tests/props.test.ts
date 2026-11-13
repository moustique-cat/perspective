// The design's four tweaks are available as address parameters. Anything out of range is ignored.
import { describe, expect, it } from 'vitest';
import type { Props } from '../src/frame';
import { readProps } from '../src/props';
import { originalProps } from './original';

const base = originalProps as unknown as Props;

describe('address parameters', () => {
  it('default to the design\'s own values', () => {
    expect(readProps('', base)).toEqual({ moustiqueLengthCm: 46, flySpeed: 0.8, handDrawn: false, ink: '#141414' });
  });
  it('accept the ranges the design declares', () => {
    expect(readProps('?cm=60', base).moustiqueLengthCm).toBe(60);
    expect(readProps('?cm=20&speed=3', base)).toMatchObject({ moustiqueLengthCm: 20, flySpeed: 3 });
    expect(readProps('?speed=0.2', base).flySpeed).toBe(0.2);
    expect(readProps('?ink=26304a', base).ink).toBe('#26304A');
    expect(readProps('?ink=%233B2F27', base).ink).toBe('#3B2F27');
    expect(readProps('?ink=abc', base).ink).toBe('#ABC');
    expect(readProps('?hand', base).handDrawn).toBe(true);
    expect(readProps('?hand=1', base).handDrawn).toBe(true);
    expect(readProps('?hand=0', base).handDrawn).toBe(false);
  });
  it('ignore anything else', () => {
    for (const q of ['?cm=19', '?cm=91', '?cm=cat', '?speed=0', '?speed=9', '?ink=red', '?ink=12', '?ink=1234567', '?ink=javascript:1', '?hands=1', '?CM=60']) {
      expect(readProps(q, base), q).toEqual(base);
    }
  });
});
