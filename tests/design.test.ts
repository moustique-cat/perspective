// The site is built from the unedited design file. These tests check that the file is still
// the one that was delivered, and that what the build takes from it is taken verbatim.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deferredLayers, startLayers } from '../src/generated/page.js';
import { originalScript, originalSource } from './original';

const read = (rel: string) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const generated = (name: string) => read('../src/generated/' + name);

describe('design/original', () => {
  it('holds the files exactly as delivered (SHA-256)', () => {
    const sums = read('../design/original/SHA256SUMS').trim().split('\n').map((line) => line.split(/\s+/));
    expect(sums.map((s) => s[1]).sort()).toEqual(['PowersRefined.dc.html', 'canvas.json']);
    for (const [sum, name] of sums) {
      const actual = createHash('sha256').update(fs.readFileSync(fileURLToPath(new URL('../design/original/' + name, import.meta.url)))).digest('hex');
      expect(actual, name + ' has been modified').toBe(sum);
    }
  });
});

describe('what the build takes from the design', () => {
  it('uses its script verbatim for all data, captions and helpers', () => {
    const core = generated('core.js');
    const body = core.slice(core.indexOf('var ZMIN'), core.lastIndexOf('\nexport {'));
    expect(body.length).toBeGreaterThan(14000);
    expect(originalScript).toContain(body);
    // and that is everything before the component class
    expect(originalScript.indexOf(body) + body.length).toBeLessThanOrEqual(originalScript.indexOf('class Component extends DCLogic'));
  });

  it('uses its stylesheet verbatim', () => {
    const css = generated('design.css').replace(/^\/\*.*\*\/\n/, '').trim();
    expect(css.length).toBeGreaterThan(2500);
    expect(originalSource).toContain(css);
  });

  it('carries every drawing layer across unchanged', () => {
    expect(startLayers.length + deferredLayers.length).toBe(33);
    // layers that leave the first response: their markup must appear in the original, byte for byte
    const late = [...generated('deferred.html').matchAll(/<template data-for="(\w+)"><svg>([\s\S]*?)<\/svg><\/template>/g)];
    expect(late.map((m) => m[1])).toEqual(deferredLayers);
    for (const [, name, markup] of late) expect(originalSource.includes(markup), `layer ${name} was altered`).toBe(true);
    // layers in the first response: every path, in order
    const page = generated('page.html');
    for (const name of startLayers) {
      const open = `data-layer="${name}"`;
      const from = page.indexOf(open);
      const next = page.indexOf('data-layer="', from + open.length);
      const mine = [...page.slice(from, next).matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
      const src = originalSource.indexOf(`{{ v.${name}.t }}`);
      const srcNext = originalSource.indexOf('{{ v.', originalSource.indexOf('display="{{ v.' + name + '.d }}"', src) + 20);
      const theirs = [...originalSource.slice(src, srcNext).matchAll(/ d="([^"{]+)"/g)].map((m) => m[1]);
      expect(mine.length, name).toBeGreaterThan(0);
      expect(mine, `layer ${name} was altered`).toEqual(theirs);
    }
  });

  it('carries every path of the drawing: none lost, none added, none changed', () => {
    const count = (s: string) => { const m = new Map<string, number>(); for (const [, d] of s.matchAll(/ d="([^"{]+)"/g)) m.set(d, (m.get(d) || 0) + 1); return m; };
    const mainSvg = originalSource.slice(originalSource.indexOf('<svg viewBox'), originalSource.indexOf('</svg>', originalSource.indexOf('<svg viewBox')));
    const theirs = count(mainSvg);
    const page = generated('page.html');
    const mine = count(page.slice(page.indexOf('<svg'), page.indexOf('</svg>')) + generated('deferred.html'));
    // two paths in the main drawing are computed per frame in the original too (the marker's leader line is one)
    const computed = [...mine.keys()].filter((d) => !theirs.has(d));
    expect(computed.length).toBeLessThanOrEqual(1);
    for (const [d, n] of theirs) expect(mine.get(d), 'a path is missing or duplicated: ' + d.slice(0, 40)).toBe(n);
    expect([...theirs.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(280);
  });

  it('keeps every word of the page text', () => {
    const page = generated('page.html');
    for (const text of ['Perspective', 'Moustique’s powers of ten', 'The space station', '100 km: where space officially starts', 'Moustique is here', 'Moustique’s kingdom: about 200 m across', 'Laniakea (‘immense heaven’)', 'More universe, its light not here yet', 'Back to Moustique', 'Light crosses this view in']) {
      expect(originalSource, text).toContain(text);
      expect(page, text).toContain(text);
    }
    const labels = (s: string) => [...s.matchAll(/<text[^>]*class="lbl[^"]*"[^>]*>([^<{]+)<\/text>/g)].map((m) => m[1]);
    expect(labels(page)).toEqual(labels(originalSource));
    expect(labels(page).length).toBeGreaterThan(38);
  });
});

describe('what the site adds around the design', () => {
  const site = read('../src/site.css');
  it('repeats the design\'s small-screen rule for short windows, unchanged', () => {
    const theirs = originalSource.match(/@media \(max-width:759px\)\{(.*)\}/)![1].trim();
    const mine = site.match(/@media \(max-height:559px\)\{(.*)\}/)![1].trim();
    expect(mine).toBe(theirs);
  });

  it('serves the faces the design asks Google Fonts for, and no others', () => {
    const link = originalSource.match(/family=EB\+Garamond:ital,wght@([^&]+)&amp;family=Inter:wght@([^&]+)&amp;display=(\w+)/)!;
    expect(link[1]).toBe('0,400;0,500;1,400');
    expect(link[2]).toBe('400;500;600');
    const faces = [...read('../src/fonts.css').matchAll(/@font-face\{font-family:'([^']+)';font-style:(\w+);font-weight:(\d+);font-display:(\w+);src:url\(\/fonts\/([^)]+)\) format\('woff2'\);unicode-range:([^}]+)\}/g)];
    const wanted = new Set(['EB Garamond normal 400', 'EB Garamond normal 500', 'EB Garamond italic 400', 'Inter normal 400', 'Inter normal 500', 'Inter normal 600']);
    expect(new Set(faces.map((f) => `${f[1]} ${f[2]} ${f[3]}`))).toEqual(wanted);
    for (const f of faces) {
      expect(f[4]).toBe(link[3]);
      expect(fs.existsSync(fileURLToPath(new URL('../public/fonts/' + f[5], import.meta.url))), f[5]).toBe(true);
    }
    expect(fs.existsSync(fileURLToPath(new URL('../public/fonts/OFL-Inter.txt', import.meta.url)))).toBe(true);
    expect(fs.existsSync(fileURLToPath(new URL('../public/fonts/OFL-EB-Garamond.txt', import.meta.url)))).toBe(true);
  });
});
