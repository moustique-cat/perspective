// Builds the reference page the pixel tests compare the site against: the original artboard,
// byte for byte, wrapped in a plain HTML page with the stand-in runtime next to it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

export function buildReference(outDir = path.join(root, '.reference')) {
  const src = fs.readFileSync(path.join(root, 'design/original/PowersRefined.dc.html'), 'utf8');
  const helmet = src.slice(src.indexOf('<helmet>') + 8, src.indexOf('</helmet>'));
  const style = helmet.match(/<style>([\s\S]*?)<\/style>/)[1];
  const template = src.slice(src.indexOf('</helmet>') + 9, src.indexOf('</x-dc>'));
  const sm = src.match(/<script type="text\/x-dc" data-dc-script data-props='([^']*)'>([\s\S]*?)<\/script>/);
  const decl = JSON.parse(sm[1]);
  const props = {};
  for (const k of Object.keys(decl)) if (!k.startsWith('$')) props[k] = decl[k].default;
  // same font files and faces as the site (and as the design's Google Fonts link)
  const fonts = fs.readFileSync(path.join(root, 'src/fonts.css'), 'utf8');
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(path.join(here, 'runtime.js'), path.join(outDir, 'runtime.js'));
  fs.writeFileSync(path.join(outDir, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Reference: the original artboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${fonts}</style>
<style>${style}</style>
</head><body>
<template id="dc-template">${template}</template>
<script id="dc-src" type="text/plain">${sm[2].replace(/<\/script/g, '<\\/script')}</script>
<script>window.__DC_PROPS = Object.assign(${JSON.stringify(props)}, JSON.parse(new URLSearchParams(location.search).get('props') || '{}'));</script>
<script src="runtime.js"></script>
</body></html>
`);
  return outDir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log('reference page written to', buildReference());
