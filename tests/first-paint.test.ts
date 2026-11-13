// index.html carries a few lines that fit the drawing to the window before the main script
// has arrived. They repeat one formula from src/frame.ts by hand; this keeps the two equal.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeFrame } from '../src/frame';
import { originalProps } from './original';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const snippet = html.match(/<script id="first-paint">([\s\S]*?)<\/script>/)![1];

function firstPaint(w: number, h: number, search = ''): { viewBox: string | null; shown: boolean } {
  let viewBox: string | null = null;
  const root = { className: '' };
  const document = { documentElement: root, querySelector: () => ({ setAttribute: (_n: string, v: string) => { viewBox = v; } }) };
  new Function('document', 'innerWidth', 'innerHeight', 'location', snippet)(document, w, h, { search });
  return { viewBox, shown: root.className === 'ready' };
}

describe('the first-paint lines in index.html', () => {
  it('place the drawing exactly where the main script will', () => {
    const props = originalProps as never;
    let checked = 0;
    for (const w of [280, 320, 390, 430, 600, 759, 760, 820, 1024, 1280, 1366, 1440, 1512, 1920, 2560, 3840]) {
      for (const h of [300, 390, 559, 560, 600, 720, 800, 820, 844, 900, 982, 1080, 1440, 2160]) {
        const frame = computeFrame({ z: 0, playing: 0, vw: w, vh: h, jump: null, announce: '', coarse: false, props }, { a: { key: '', t: '', d: '' }, b: { key: '', t: '', d: '' }, on: 'a' });
        const got = firstPaint(w, h);
        expect(got.viewBox, `${w} x ${h}`).toBe(frame.vb);
        expect(got.shown).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(224);
  });

  it('step aside when the address asks for a different cat length or the hand-drawn line', () => {
    for (const search of ['?cm=60', '?hand', '?hand=1', '?ink=26304A&hand=1', '?x=1&cm=30']) {
      expect(firstPaint(1280, 820, search), search).toEqual({ viewBox: null, shown: false });
    }
    for (const search of ['?speed=2', '?handy=1', '?ink=26304A']) expect(firstPaint(1280, 820, search).shown, search).toBe(true);
  });
});

describe('the address-ink lines in index.html', () => {
  const inkSnippet = html.match(/<script id="address-ink">([\s\S]*?)<\/script>/)![1];
  function addressInk(search: string): string | null {
    let css: string | null = null;
    const document = { createElement: () => ({ set textContent(v: string) { css = v; } }), head: { appendChild() {} } };
    new Function('document', 'location', inkSnippet)(document, { search });
    return css;
  }
  it('set a valid ink colour before the page is styled, and ignore anything else', () => {
    expect(addressInk('?ink=26304A')).toBe('.ink{color:#26304A !important}');
    expect(addressInk('?cm=50&ink=%233b2f27')).toBe('.ink{color:#3b2f27 !important}');
    expect(addressInk('?ink=abc&speed=2')).toBe('.ink{color:#abc !important}');
    for (const search of ['', '?ink=', '?ink=red', '?ink=12345', '?ink=1234567', '?ink=26304A;background:url(x)', '?think=26304A']) {
      expect(addressInk(search), search).toBeNull();
    }
  });
});
