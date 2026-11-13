// The renderer for devices with WebGPU. Fetched by the page once it is zoomable.
import type { Start } from './host';
import { run } from './renderer';
import { createWebGPU, isFallback } from './webgpu';

export const start: Start = async (host, options) => {
  const adapter = (options.adapter as GPUAdapter | undefined) || await navigator.gpu.requestAdapter();
  // an adapter that draws on the processor is no gain over the browser's own SVG drawing
  if (!adapter || (!options.force && isFallback(adapter))) return null;
  // asked for outright on an adapter that draws on the processor: a test, in a browser that cannot show such a canvas
  const backend = await createWebGPU(document.createElement('canvas'), adapter, !(options.force && isFallback(adapter)));
  if (!backend) return null;
  return run(host, backend, () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }), options.fault);
};
