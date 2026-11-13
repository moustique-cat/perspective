// Reads the drawing out of the page: the same elements the SVG shows, with the styles the
// browser computed for them. The renderer has no copy of the drawing of its own, so the two
// pictures have identical content by construction.
//
// Strict on purpose: anything in the drawing this renderer does not know how to draw makes
// it step aside (the SVG stays), rather than draw something else.
import type { RawElement, RawSheet } from './levels';
import { IDENTITY, multiply, parseTransform, type Matrix } from './path';
import { INK, NONE, WHITE } from './scene';

export const ATMOSPHERE = -1, EARTH = -2;

export interface PageScene {
  /** The group of the SVG that the renderer replaces. */
  drawing: SVGGElement;
  /** Every layer, then the Earth's grid and the ground line. */
  sheets: RawSheet[];
  /** Paint order: an index into sheets, or ATMOSPHERE or EARTH for the two true circles. */
  order: number[];
  /** The distinct stroke widths, CSS px. */
  widths: number[];
  atmosphere: { width: number; opacity: number; dash: [number, number] };
  earth: { width: number };
}

interface Style { width: number; opacity: number; dash: [number, number] | null; fill: 0 | 1 | 2 }

export function readPage(svg: SVGSVGElement): PageScene {
  const drawing = svg.querySelector<SVGGElement>('g[filter]');
  if (!drawing) throw new Error('the drawing group is missing');
  if (svg.querySelector('template')) throw new Error('layers are still arriving');

  const styles = new Map<string, Style>();
  const styleOf = (el: Element): Style => {
    const key = (el.getAttribute('class') || '') + '|' + (el.getAttribute('style') || '');
    let style = styles.get(key);
    if (!style) {
      const cs = getComputedStyle(el);
      const stroked = cs.stroke !== 'none';
      if (stroked && (cs.strokeLinecap !== 'round' || cs.strokeLinejoin !== 'round' || cs.getPropertyValue('vector-effect') !== 'non-scaling-stroke')) {
        throw new Error('a stroke that is not round and non-scaling: ' + key);
      }
      const dash = cs.strokeDasharray === 'none' ? null : cs.strokeDasharray.split(/[\s,]+/).map(parseFloat);
      if (dash && (dash.length !== 2 || !(dash[0] > 0) || !(dash[1] > 0))) throw new Error('a dash pattern other than "on off": ' + cs.strokeDasharray);
      style = {
        width: stroked ? parseFloat(cs.strokeWidth) : 0,
        opacity: parseFloat(cs.strokeOpacity),
        dash: dash ? [dash[0], dash[1]] : null,
        fill: cs.fill === 'none' ? NONE : /^rgba?\(255, 255, 255(, 1)?\)$/.test(cs.fill) ? WHITE : INK,
      };
      if (!(style.width >= 0) || !(style.opacity >= 0)) throw new Error('a stroke style that cannot be read: ' + key);
      styles.set(key, style);
    }
    return style;
  };

  const element = (el: Element, matrix: Matrix, opacity: number): RawElement => {
    const style = styleOf(el);
    let d: string | null = null, circle: [number, number, number] | null = null;
    if (el.tagName === 'path') d = el.getAttribute('d') || '';
    else if (el.tagName === 'circle') circle = [Number(el.getAttribute('cx') || 0), Number(el.getAttribute('cy') || 0), Number(el.getAttribute('r'))];
    else if (el.tagName === 'line') d = `M${el.getAttribute('x1')} ${el.getAttribute('y1')}L${el.getAttribute('x2')} ${el.getAttribute('y2')}`;
    else throw new Error('<' + el.tagName + '> in the drawing is not supported');
    return { d, circle, matrix, width: style.width, opacity: style.opacity * opacity, dash: style.dash, fill: style.fill };
  };

  /** The elements under a group, with the transforms and opacities of the groups between. */
  const gather = (group: Element, matrix: Matrix, opacity: number, into: RawElement[]): number => {
    let count = 0;
    for (const child of Array.from(group.children)) {
      if (child.tagName === 'g') {
        const own = child.getAttribute('opacity');
        const held = gather(child, multiply(matrix, parseTransform(child.getAttribute('transform'))), opacity * (own === null ? 1 : Number(own)), into);
        // a group's opacity belongs to the group as a whole; applied to a single element it is the same thing
        if (own !== null && Number(own) < 1 && held !== 1) throw new Error('a translucent group with ' + held + ' elements is not supported');
        count += held;
      } else {
        into.push(element(child, matrix, opacity));
        count++;
      }
    }
    return count;
  };

  const sheets: RawSheet[] = [], order: number[] = [];
  let grid: RawSheet | null = null, ground: RawSheet | null = null;
  let atmosphere: PageScene['atmosphere'] | null = null, earth: PageScene['earth'] | null = null;
  const widths: number[] = [];
  const widthIndex = (w: number): number => {
    let i = widths.indexOf(w);
    if (i < 0) { i = widths.length; widths.push(w); }
    return i;
  };
  for (const child of Array.from(drawing.children)) {
    const name = child.getAttribute('data-layer');
    if (child.tagName === 'g' && name) {
      const sheet: RawSheet = { name, elements: [] };
      // the layer's own scale and opacity are set every frame; they are not part of its marks
      gather(child, IDENTITY, 1, sheet.elements);
      if (!sheet.elements.length) throw new Error('layer ' + name + ' is empty');
      order.push(sheets.length);
      sheets.push(sheet);
    } else if (child.tagName === 'circle' && !atmosphere && styleOf(child).dash) {
      const s = styleOf(child);
      atmosphere = { width: widthIndex(s.width), opacity: s.opacity, dash: s.dash! };
      order.push(ATMOSPHERE);
    } else if (child.tagName === 'circle' && !earth && styleOf(child).fill === WHITE) {
      earth = { width: widthIndex(styleOf(child).width) };
      order.push(EARTH);
    } else if (child.tagName === 'g' && !grid) {
      grid = { name: 'grid', elements: [] };
      gather(child, IDENTITY, 1, grid.elements);
      order.push(-3);
    } else if (child.tagName === 'line' && !ground) {
      // its height on the page changes every frame; as a mark it is a level line through the origin
      const flat = element(child, IDENTITY, 1);
      flat.d = `M${child.getAttribute('x1')} 0L${child.getAttribute('x2')} 0`;
      ground = { name: 'ground', elements: [flat] };
      order.push(-4);
    } else {
      throw new Error('<' + child.tagName + '> in the drawing is not supported here');
    }
  }
  if (!grid || !ground || !atmosphere || !earth) throw new Error('the Earth, its grid, its atmosphere or the ground is missing');
  const gridAt = sheets.length, groundAt = sheets.length + 1;
  sheets.push(grid, ground);
  for (const sheet of sheets) for (const e of sheet.elements) if (e.width > 0) widthIndex(e.width);
  if (widths.length > 8) throw new Error('more than eight stroke widths');
  return { drawing, sheets, order: order.map((o) => (o === -3 ? gridAt : o === -4 ? groundAt : o)), widths, atmosphere, earth };
}
