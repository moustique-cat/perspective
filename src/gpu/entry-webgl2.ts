// The renderer for devices with WebGL2 and no WebGPU. Fetched by the page once it is zoomable.
import type { Start } from './host';
import { run } from './renderer';
import { isSoftware } from './attributes';
import { createWebGL2 } from './webgl2';

export const start: Start = async (host, options) => {
  const backend = createWebGL2(options.canvas || document.createElement('canvas'));
  if (!backend) return null;
  // without a graphics chip the browser's own SVG drawing is the faster of the two
  if (!options.force && isSoftware(backend.chip)) { backend.destroy(); return null; }
  return run(host, backend, () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));
};
