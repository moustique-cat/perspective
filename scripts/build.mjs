// Builds the site into dist/.
//
// The page stays one response with one script inside it (vite.config.ts). The renderer is
// built separately, one self-contained file per backend plus the worker they share, under
// dist/gpu/ with the content's hash in each name; the page is then built knowing those names.
// A device fetches the one renderer it will use, after the page is zoomable; a device that
// stays with the SVG fetches none.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });

async function renderer(name, source = `src/gpu/entry-${name}.ts`) {
  const result = await build({
    configFile: false,
    root,
    base: './',
    logLevel: 'warn',
    publicDir: false,
    worker: { format: 'es', rolldownOptions: { output: { entryFileNames: 'gpu/levels-[hash].js' } } },
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      target: 'es2022',
      modulePreload: false,
      assetsDir: 'gpu',
      rolldownOptions: {
        input: { [name]: path.join(root, source) },
        preserveEntrySignatures: 'strict',
        output: { format: 'es', entryFileNames: 'gpu/[name]-[hash].js', assetFileNames: 'gpu/[name]-[hash][extname]' },
      },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output);
  const entry = outputs.find((o) => o.type === 'chunk' && o.isEntry);
  if (!entry) throw new Error(`the ${name} renderer produced no file`);
  const extra = outputs.filter((o) => o !== entry && !/^gpu\/levels-/.test(o.fileName));
  if (extra.length) throw new Error(`the ${name} renderer must stay in one file (plus the worker); also got ${extra.map((o) => o.fileName).join(', ')}`);
  return entry.fileName;
}

// the speed report behind ?bench is built the same way: a file of its own, fetched only when asked for
const files = { webgl2: await renderer('webgl2'), webgpu: await renderer('webgpu'), bench: await renderer('bench', 'src/bench.ts') };
await build({
  root,
  logLevel: 'warn',
  define: { __GPU_FILES__: JSON.stringify(files) },
  build: { emptyOutDir: false },
});

const kb = (file) => (fs.statSync(path.join(root, 'dist', file)).size / 1024).toFixed(1) + ' kB';
const made = fs.readdirSync(path.join(root, 'dist/gpu')).map((f) => 'gpu/' + f);
console.log(`built: index.html ${kb('index.html')}; ${made.map((f) => `${f} ${kb(f)}`).join('; ')}`);
