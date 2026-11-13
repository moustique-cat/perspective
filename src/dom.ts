// Writes a frame into the page.
//
// The page markup comes from the design with every {{ value }} already filled in for the
// first frame; the generator also emits a table saying which attribute or text node each
// value lives in. Each frame, only the entries whose text actually changed touch the DOM.
import type { Frame } from './frame';

/**
 * [element index, kind, name, value] where kind says what `name` is: an attribute (0), the
 * index of a text node among the element's children (1), a CSS property (2) or the `value`
 * property of an input (3). `value` is [text, path, text, path, ..., text], or just a path
 * when the whole value is one lookup into the frame.
 */
export type Binding = [number, 0 | 1 | 2 | 3, string | number, string | string[]];
const ATTR = 0, TEXT = 1, STYLE = 2, VALUE = 3;

interface Slot {
  kind: number;
  el: Element;
  name: string;
  node: Text | null;
  parts: string[];
  paths: string[][];
  last: string | null;
}

export interface Page {
  apply(frame: Frame): void;
  /** Elements that carry event markers, with their parsed "type:handler[:argument]" entries. */
  events: { el: Element; type: string; handler: string; arg: string | undefined }[];
  layer(name: string): Element | null;
}

export function mountPage(root: Element, bindings: Binding[]): Page {
  // the root element carries bindings and events of its own
  const all = (selector: string) => [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)];
  const els: Element[] = [];
  for (const el of all('[data-b]')) els[Number(el.getAttribute('data-b'))] = el;

  const slots: Slot[] = bindings.map(([i, kind, key, value]) => {
    const el = els[i];
    if (!el) throw new Error(`page markup and binding table disagree at element ${i}`);
    const parts = typeof value === 'string' ? ['', value, ''] : value;
    let node: Text | null = null;
    if (kind === TEXT) {
      const at = el.childNodes[key as number];
      if (at && at.nodeType === 3) {
        node = at as Text;
      } else {
        // a value that was empty in the first frame leaves no text node behind: make one
        node = document.createTextNode('');
        el.insertBefore(node, at || null);
      }
    }
    const paths: string[][] = [];
    for (let k = 1; k < parts.length; k += 2) paths.push(parts[k].split('.'));
    return { kind, el, name: String(key), node, parts, paths, last: null };
  });

  const events: Page['events'] = [];
  for (const el of all('[data-e]')) {
    for (const entry of (el.getAttribute('data-e') || '').split(' ')) {
      const [type, handler, arg] = entry.split(':');
      events.push({ el, type, handler, arg });
    }
  }

  function apply(frame: Frame): void {
    for (let n = 0; n < slots.length; n++) {
      const s = slots[n];
      let text = s.parts[0];
      for (let k = 0; k < s.paths.length; k++) {
        const path = s.paths[k];
        let v: unknown = frame;
        for (let d = 0; d < path.length && v != null; d++) v = (v as Record<string, unknown>)[path[d]];
        text += (v == null ? '' : v) + s.parts[2 * k + 2];
      }
      if (text === s.last) continue;
      s.last = text;
      if (s.kind === ATTR) s.el.setAttribute(s.name, text);
      else if (s.kind === TEXT) s.node!.nodeValue = text;
      else if (s.kind === STYLE) (s.el as HTMLElement).style.setProperty(s.name, text);
      else if (s.kind === VALUE) (s.el as HTMLInputElement).value = text;
    }
  }

  return {
    apply,
    events,
    layer: (name) => root.querySelector(`[data-layer="${name}"]`),
  };
}
