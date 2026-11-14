// The design's layers as the renderer reads them, built from the generated markup without a
// browser: the same elements, classes and transforms the page holds, styled by the rules of
// the design's own stylesheet.
import fs from 'node:fs';
import { IDENTITY, circle, multiply, parsePath, parseTransform, type Matrix, type Subpath } from '../src/gpu/path';
import { INK, NONE, WHITE, type ElementSource, type LayerSource } from '../src/gpu/scene';

const read = (file: string) => fs.readFileSync(new URL(`../src/generated/${file}`, import.meta.url), 'utf8');

/** class name -> declarations, from the design's ".ink .name{...}" rules, later rules winning. */
export function designStyles(): Record<string, Record<string, string>> {
  const styles: Record<string, Record<string, string>> = {};
  for (const rule of read('design.css').matchAll(/([^{}\n]+)\{([^}]*)\}/g)) {
    const names = rule[1].split(',').map((s) => s.trim().match(/^\.ink \.(\w+)$/)).filter(Boolean).map((m) => m![1]);
    for (const name of names) {
      styles[name] ||= {};
      for (const decl of rule[2].split(';')) {
        const at = decl.indexOf(':');
        if (at > 0) styles[name][decl.slice(0, at).trim()] = decl.slice(at + 1).trim();
      }
    }
  }
  return styles;
}

interface Tag { name: string; attrs: Record<string, string>; close: boolean; selfClose: boolean }
function* tags(markup: string): Generator<Tag> {
  for (const m of markup.matchAll(/<(\/)?([A-Za-z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/)?>/g)) {
    const attrs: Record<string, string> = {};
    for (const a of m[3].matchAll(/([^\s=>/]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] ?? '';
    yield { name: m[2], attrs, close: !!m[1], selfClose: !!m[4] };
  }
}

export interface SourceOptions { cm?: number }

/** Every layer of the design, in paint order, with the elements the page would hold. */
export function designLayers(): LayerSource[] {
  const styles = designStyles();
  const late = new Map<string, string>();
  for (const m of read('deferred.html').matchAll(/<template data-for="(\w+)"><svg>([\s\S]*?)<\/svg><\/template>/g)) late.set(m[1], m[2]);
  // put the late layers back where the page puts them
  const page = read('page.html').replace(/(<g [^>]*data-layer="(\w+)"[^>]*>)(<\/g>)/g, (_all, open, name, close) => open + (late.get(name) ?? '') + close);
  const svg = page.slice(page.indexOf('<svg'), page.indexOf('</svg>'));

  const layers: LayerSource[] = [];
  let layer: LayerSource | null = null, depth = 0;
  const stack: { matrix: Matrix; opacity: number; own: number }[] = [];
  for (const tag of tags(svg)) {
    if (tag.name === 'g') {
      if (tag.close) {
        if (!layer) continue;
        const top = stack.pop()!;
        if (top.opacity < 1 && top.own !== 1) throw new Error(`a group with opacity holds ${top.own} elements in layer ${layer.name}; only one is supported`);
        if (--depth === 0) { layers.push(layer); layer = null; }
        continue;
      }
      if (!layer) {
        if (!tag.attrs['data-layer']) continue;
        layer = { name: tag.attrs['data-layer'], elements: [] };
        depth = 1;
        // the layer's own scale and opacity change every frame; they are not part of its marks
        stack.push({ matrix: IDENTITY, opacity: 1, own: 1 });
        continue;
      }
      depth++;
      const parent = stack[stack.length - 1];
      stack.push({ matrix: multiply(parent.matrix, parseTransform(tag.attrs.transform)), opacity: parent.opacity * (tag.attrs.opacity === undefined ? 1 : Number(tag.attrs.opacity)), own: 0 });
      continue;
    }
    if (!layer || tag.close) continue;
    let paths: Subpath[];
    if (tag.name === 'path') paths = parsePath(tag.attrs.d);
    else if (tag.name === 'circle') paths = [circle(Number(tag.attrs.cx || 0), Number(tag.attrs.cy || 0), Number(tag.attrs.r))];
    else throw new Error(`<${tag.name}> inside layer ${layer.name} is not supported`);
    const style: Record<string, string> = {};
    for (const name of (tag.attrs.class || '').split(/\s+/)) Object.assign(style, styles[name]);
    for (const decl of (tag.attrs.style || '').split(';')) { const at = decl.indexOf(':'); if (at > 0) style[decl.slice(0, at).trim()] = decl.slice(at + 1).trim(); }
    const top = stack[stack.length - 1];
    top.own++;
    const dash = style['stroke-dasharray'] ? style['stroke-dasharray'].split(/[\s,]+/).map(Number) : null;
    const el: ElementSource = {
      paths,
      matrix: top.matrix,
      width: style.stroke === 'none' ? 0 : Number(style['stroke-width'] ?? 1),
      opacity: Number(style['stroke-opacity'] ?? 1) * top.opacity,
      dash: dash ? [dash[0], dash[1]] : null,
      fill: style.fill === '#FFFFFF' ? WHITE : style.fill === 'currentColor' ? INK : NONE,
    };
    layer.elements.push(el);
  }
  return layers;
}
