import fs from 'node:fs';
import { defineConfig, type Plugin } from 'vitest/config';

const generated = (file: string) => fs.readFileSync(new URL(`./src/generated/${file}`, import.meta.url), 'utf8');

/** Puts the markup extracted from the design into the page (see scripts/extract-design.mjs). */
function designPage(): Plugin {
  return {
    name: 'perspective:design-page',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => html
        .replace('<!--page-->', () => generated('page.html'))
        .replace('<!--deferred-->', () => generated('deferred.html')),
    },
  };
}

/**
 * Makes the built site one response, in the order a visitor needs it: styles, the first view,
 * the script, then the layers that are not on screen yet. The script is inlined as a classic
 * script at its place in the body so it runs when the first view has arrived, not when the
 * whole document has.
 */
function singleResponse(): Plugin {
  return {
    name: 'perspective:single-response',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const html = bundle['index.html'];
      if (!html || html.type !== 'asset') throw new Error('index.html is missing from the build');
      let page = String(html.source);
      let scripts = 0, styles = 0;
      for (const [name, file] of Object.entries(bundle)) {
        if (file.type === 'chunk') {
          if (!file.isEntry) throw new Error(`unexpected extra chunk ${name}: the script must stay in one piece`);
          const before = page;
          page = page.replace(/<script type="module"[^>]*\ssrc="[^"]*"[^>]*><\/script>\s*/, '');
          if (page === before) throw new Error('script tag not found in index.html');
          page = page.replace('<!--app-->', () => `<script>${file.code.trim().replace(/<\/script/gi, '<\\/script')}</script>`);
          delete bundle[name];
          scripts++;
        } else if (name.endsWith('.css')) {
          const before = page;
          // The stylesheet is not minified (see cssMinify below); only comments and blank lines
          // go. It moves from assets/ into the page, so its relative URLs lose one level.
          const css = String(file.source).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\n\s*\n+/g, '\n').trim().replace(/url\((['"]?)\.\.\//g, 'url($1./');
          page = page.replace(/<link rel="stylesheet"[^>]*>\s*/, () => `<style>${css}</style>\n`);
          if (page === before) throw new Error('stylesheet link not found in index.html');
          delete bundle[name];
          styles++;
        }
      }
      if (scripts !== 1 || styles !== 1 || page.includes('<!--app-->')) throw new Error(`expected one script and one stylesheet to inline, found ${scripts} and ${styles}`);
      html.source = page;
    },
  };
}

export default defineConfig({
  // relative, so the site works at any path: user.github.io/repo/ or a domain of its own
  base: './',
  plugins: [designPage(), singleResponse()],
  build: {
    target: 'es2022',
    modulePreload: false,
    cssCodeSplit: false,
    // The design's stylesheet ships as written. A minifier would drop its fallback colours
    // (the plain colour before each color-mix()), which older browsers rely on.
    cssMinify: false,
    assetsInlineLimit: 0,
    rolldownOptions: {
      output: { format: 'iife' },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // the motion tests replay whole flights frame by frame against the original
    testTimeout: 120_000,
  },
});
