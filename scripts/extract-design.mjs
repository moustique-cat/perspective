// Turns the unedited design file into the pieces the site is built from.
//
// The drawing, the captions and the stylesheet are taken from
// design/original/PowersRefined.dc.html by this script on every build. Nothing in that file
// is ever retyped or edited by hand. The only changes made on the way are these, each of
// which is checked by the tests:
//
//   - The Google Fonts <link> is dropped: the same font files are served from the site.
//   - The rail's track, tick marks and exponent positions become computed values, so the rail
//     can follow the window height. At 820 px they equal the original's literals.
//   - <sc-for> over the landmarks is expanded into its 26 buttons.
//   - React-style event attributes become data-e markers that the runtime wires up.
//   - Layers that are invisible at the home zoom are moved, unchanged, to the end of the
//     document.
//
// Output (src/generated/, not committed):
//   core.js        the original script up to its component class, verbatim, plus exports
//   design.css     the original stylesheet, verbatim
//   page.html      the page markup, already drawn at the home zoom
//   deferred.html  the layers that are not visible at the home zoom, nearest first
//   page.js        binding table and constants for the runtime and the tests
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGINAL = path.join(ROOT, 'design/original/PowersRefined.dc.html');
const OUT = path.join(ROOT, 'src/generated');

const HOLE = /\{\{\s*([\w.$]+)\s*\}\}/g;
const VOID = new Set(['input', 'link', 'meta', 'br', 'img', 'hr']);
const EVENTS = { onWheel: 'wheel', onClick: 'click', onChange: 'input', onKeyDown: 'keydown', onPointerDown: 'pointerdown', onPointerMove: 'pointermove', onPointerUp: 'pointerup', onPointerCancel: 'pointercancel' };

function fail(msg) { throw new Error('extract-design: ' + msg); }
function between(s, a, b) {
  const i = s.indexOf(a), j = s.indexOf(b, i + a.length);
  if (i < 0 || j < 0) fail(`cannot find ${a} ... ${b}`);
  return s.slice(i + a.length, j);
}

// ---- a strict little parser: the design format guarantees quoted attributes and closed tags
function parse(html) {
  const root = { tag: '#root', attrs: [], children: [] };
  const stack = [root];
  const re = /<\/([A-Za-z][\w-]*)\s*>|<([A-Za-z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*>|([^<]+)/g;
  let m, at = 0;
  while ((m = re.exec(html))) {
    if (m.index !== at) fail(`unparsed markup at ${at}: ${html.slice(at, at + 60)}`);
    at = re.lastIndex;
    const top = stack[stack.length - 1];
    if (m[1]) {
      if (top.tag !== m[1]) fail(`</${m[1]}> closes <${top.tag}>`);
      stack.pop();
    } else if (m[2]) {
      const node = { tag: m[2], attrs: [], children: [] };
      const ar = /([^\s=>/]+)(?:="([^"]*)")?/g;
      let a;
      while ((a = ar.exec(m[3]))) node.attrs.push([a[1], a[2] === undefined ? null : a[2]]);
      top.children.push(node);
      if (!VOID.has(node.tag)) stack.push(node);
    } else {
      top.children.push({ text: m[4] });
    }
  }
  if (at !== html.length) fail(`unparsed tail at ${at}`);
  if (stack.length !== 1) fail(`unclosed <${stack[stack.length - 1].tag}>`);
  return root;
}
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
function serialize(node) {
  if (node.text !== undefined) return node.text;
  if (node.tag === '#root') return node.children.map(serialize).join('');
  const attrs = node.attrs.map(([k, v]) => (v === null ? ` ${k}` : ` ${k}="${v}"`)).join('');
  if (VOID.has(node.tag)) return `<${node.tag}${attrs}>`;
  return `<${node.tag}${attrs}>${node.children.map(serialize).join('')}</${node.tag}>`;
}
const attr = (n, k) => { const a = n.attrs.find((x) => x[0] === k); return a ? a[1] : undefined; };
const setAttr = (n, k, v) => { const a = n.attrs.find((x) => x[0] === k); if (a) a[1] = v; else n.attrs.push([k, v]); };
const hasClass = (n, c) => (attr(n, 'class') || '').split(/\s+/).includes(c);
function walk(node, fn, parent = null) {
  fn(node, parent);
  if (node.children) for (const c of [...node.children]) walk(c, fn, node);
}
const find = (node, pred) => { const out = []; walk(node, (n) => { if (n.tag && pred(n)) out.push(n); }); return out; };
const clone = (n) => (n.text !== undefined ? { text: n.text } : { tag: n.tag, attrs: n.attrs.map((a) => [...a]), children: n.children.map(clone) });
const look = (scope, p) => p.split('.').reduce((v, k) => (v == null ? undefined : v[k]), scope);

// ---- read the original
const src = fs.readFileSync(ORIGINAL, 'utf8');
const helmet = between(src, '<helmet>', '</helmet>');
const css = between(helmet, '<style>', '</style>');
if (!/<link href="https:\/\/fonts\.googleapis\.com\/css2\?family=EB\+Garamond[^"]*Inter[^"]*" rel="stylesheet">/.test(helmet)) fail('font link changed: check src/fonts.css still matches it');
const template = between(src, '</helmet>', '</x-dc>').trim();
const sm = src.match(/<script type="text\/x-dc" data-dc-script data-props='([^']*)'>([\s\S]*?)<\/script>/);
if (!sm) fail('component script not found');
const propDecl = JSON.parse(sm[1]);
const script = sm[2];
const props = {};
for (const k of Object.keys(propDecl)) if (!k.startsWith('$')) props[k] = propDecl[k].default;
const preview = propDecl.$preview;

// ---- the script: everything before the component class is data, captions and pure helpers
const cut = script.indexOf('\nclass Component extends DCLogic');
if (cut < 0) fail('component class not found');
const coreSrc = script.slice(0, cut).replace(/^\n+/, '');
const ctx = {};
vm.runInNewContext(coreSrc, ctx);
const coreNames = Object.keys(ctx);
for (const need of ['ZMIN', 'ZMAX', 'Z0', 'OBJ', 'LAB', 'LMS', 'GAPS', 'PRE', 'RAIL_TOPS', 'T0', 'TH', 'RAIL_W', 'capFor', 'dwell', 'win', 'vis', 'fmtLen', 'fmtTime', 'sig', 'nearest', 'smooth01']) {
  if (!coreNames.includes(need)) fail(`original script no longer defines ${need}`);
}

// ---- run the original component once, at the size it was designed at, to draw the first frame
function originalFrame(width) {
  class DCLogic {
    constructor(p) { this.props = p; }
    setState(u) { this.state = Object.assign({}, this.state, u); }
  }
  const win = { innerWidth: width, addEventListener() {}, removeEventListener() {} };
  const Component = new Function('DCLogic', 'window', 'requestAnimationFrame', 'cancelAnimationFrame', script + '\n;return Component;')(DCLogic, win, undefined, undefined);
  const c = new Component({ ...props });
  c.renderVals();
  c.componentDidMount();
  return c.renderVals();
}
const vals = originalFrame(preview.width);

// ---- transform the template
const tree = parse(template);
const rootEl = tree.children.find((n) => n.tag);
if (!rootEl || !hasClass(rootEl, 'ink')) fail('root element changed');

// rail: literals that depend on the 820 px height become holes
const rail = find(rootEl, (n) => n.tag === 'nav' && hasClass(n, 'rail'))[0] || fail('rail not found');
const railSvg = rail.children.find((n) => n.tag === 'svg');
const tr = find(railSvg, (n) => n.tag === 'path' && hasClass(n, 'tr'));
const tk = find(railSvg, (n) => n.tag === 'path' && hasClass(n, 'tk'));
const ex = find(railSvg, (n) => n.tag === 'text' && hasClass(n, 'ex'));
if (tr.length !== 1 || tk.length !== 2 || ex.length !== 9) fail('rail drawing changed');
const originalRail = { tr: attr(tr[0], 'd'), tk: attr(tk[0], 'd'), lt: attr(tk[1], 'd'), ex: ex.map((n) => attr(n, 'y')), exText: ex.map((n) => serialize(n.children[0])) };
setAttr(tr[0], 'd', '{{ rail.tr }}');
setAttr(tk[0], 'd', '{{ rail.tk }}');
setAttr(tk[1], 'd', '{{ rail.lt }}');
ex.forEach((n, i) => setAttr(n, 'y', `{{ rail.ex.${i} }}`));
vals.rail = { tr: originalRail.tr, tk: originalRail.tk, lt: originalRail.lt, ex: originalRail.ex };

// landmarks: expand the repeat
walk(rootEl, (n, parent) => {
  if (n.tag !== 'sc-for') return;
  const list = attr(n, 'list').match(/\{\{\s*([\w.]+)\s*\}\}/)[1], as = attr(n, 'as');
  const items = look(vals, list);
  const out = [];
  items.forEach((_, j) => {
    for (const child of n.children) {
      const c = clone(child);
      walk(c, (x) => {
        const re = new RegExp(`\\{\\{\\s*${as}\\.([\\w.]+)\\s*\\}\\}`, 'g');
        if (x.text !== undefined) x.text = x.text.replace(re, `{{ ${list}.${j}.$1 }}`);
        else x.attrs.forEach((a) => { if (a[1]) a[1] = a[1].replace(re, `{{ ${list}.${j}.$1 }}`); });
      });
      out.push(c);
    }
  });
  parent.children.splice(parent.children.indexOf(n), 1, ...out);
});

// layers: name them; the ones that are invisible at the home zoom leave the first response
const layers = [];
walk(rootEl, (n) => {
  if (n.tag !== 'g') return;
  const m = (attr(n, 'transform') || '').match(/^\{\{\s*v\.(\w+)\.t\s*\}\}$/);
  if (!m) return;
  n.attrs.unshift(['data-layer', m[1]]);
  layers.push({ name: m[1], node: n });
});
const OBJ = ctx.OBJ, Z0 = ctx.Z0;
if (layers.length !== Object.keys(OBJ).length) fail('layer list and OBJ table disagree');
const startLayers = layers.filter((l) => vals.v[l.name].d !== 'none').map((l) => l.name);
const deferred = layers.filter((l) => !startLayers.includes(l.name)).map((l) => {
  const [, a, b] = OBJ[l.name];
  const kids = l.node.children;
  l.node.children = [];
  if (HOLE.test(kids.map(serialize).join(''))) fail(`deferred layer ${l.name} contains a binding`);
  HOLE.lastIndex = 0;
  return { name: l.name, away: Z0 < a ? a - Z0 : Z0 > b ? Z0 - b : 0, html: kids.map(serialize).join('') };
}).sort((p, q) => p.away - q.away);

// bindings: every {{ hole }} becomes an entry in a table; the markup is filled in for the first frame
const bindings = [];
let count = 0;
const split = (tpl) => {
  const parts = []; let last = 0, m;
  HOLE.lastIndex = 0;
  while ((m = HOLE.exec(tpl))) { parts.push(tpl.slice(last, m.index), m[1]); last = HOLE.lastIndex; }
  parts.push(tpl.slice(last));
  return parts;
};
// a value that is one hole and nothing else is stored as just its path
const compact = (parts) => (parts.length === 3 && parts[0] === '' && parts[2] === '' ? parts[1] : parts);
const fill = (parts, esc) => parts.map((p, i) => (i % 2 ? esc(look(vals, p) ?? '') : p)).join('');
walk(rootEl, (n) => {
  if (!n.tag) return;
  let id = -1;
  const need = () => { if (id < 0) { id = count++; n.attrs.unshift(['data-b', String(id)]); } return id; };
  const events = [];
  for (const a of [...n.attrs]) {
    const [k, v] = a;
    if (EVENTS[k]) {
      const p = v.match(/^\{\{\s*([\w.]+)\s*\}\}$/)[1];
      const lm = p.match(/^landmarks\.(\d+)\.pick$/);
      events.push(lm ? `${EVENTS[k]}:pick:${lm[1]}` : `${EVENTS[k]}:${p}`);
      n.attrs.splice(n.attrs.indexOf(a), 1);
      continue;
    }
    if (v === null || !v.includes('{{')) continue;
    if (/^on[A-Z]/.test(k)) fail(`unknown event attribute ${k}`);
    if (k === 'style') {
      // bind only the declarations that change, one property each; the rest stays in the markup
      for (const decl of v.split(';')) {
        if (!decl.includes('{{')) continue;
        const colon = decl.indexOf(':');
        bindings.push([need(), 2, decl.slice(0, colon).trim(), compact(split(decl.slice(colon + 1).trim()))]);
      }
      a[1] = fill(split(v), escAttr);
      continue;
    }
    const parts = split(v);
    bindings.push([need(), k === 'value' ? 3 : 0, k, compact(parts)]);
    a[1] = fill(parts, escAttr);
  }
  if (events.length) n.attrs.push(['data-e', events.join(' ')]);
  n.children.forEach((c, i) => {
    if (c.text === undefined || !c.text.includes('{{')) return;
    const parts = split(c.text);
    bindings.push([need(), 1, i, compact(parts)]);
    c.text = fill(parts, escText);
  });
});
if (HOLE.test(serialize(rootEl))) fail('a binding was left in the page');

// ---- write
fs.mkdirSync(OUT, { recursive: true });
const banner = '// GENERATED by scripts/extract-design.mjs from design/original/PowersRefined.dc.html. Do not edit.\n';
fs.writeFileSync(path.join(OUT, 'core.js'), `${banner}/* eslint-disable */\n${coreSrc}\nexport { ${coreNames.join(', ')} };\n`);
fs.writeFileSync(path.join(OUT, 'design.css'), `/* GENERATED: the original stylesheet, verbatim. Do not edit. */\n${css.trim()}\n`);
fs.writeFileSync(path.join(OUT, 'page.html'), serialize(rootEl) + '\n');
fs.writeFileSync(path.join(OUT, 'deferred.html'), deferred.map((d) => `<template data-for="${d.name}"><svg>${d.html}</svg></template><script>window.__L&&__L()</script>`).join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'page.js'), banner + [
  `export const bindings = ${JSON.stringify(bindings)};`,
  `export const props = ${JSON.stringify(props)};`,
  `export const preview = ${JSON.stringify(preview)};`,
  `export const startLayers = ${JSON.stringify(startLayers)};`,
  `export const deferredLayers = ${JSON.stringify(deferred.map((d) => d.name))};`,
  `export const originalRail = ${JSON.stringify(originalRail)};`,
].join('\n') + '\n');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1) + ' KB';
  console.log(`design extracted: ${layers.length} layers (${startLayers.length} in the first response: ${startLayers.join(', ')}), ${bindings.length} bindings, page ${kb(serialize(rootEl))}, deferred ${kb(deferred.map((d) => d.html).join(''))}`);
}
