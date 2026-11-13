// The WebGPU backend: for devices that have it. Draws the same frame plan as the WebGL2 one.
import { C_CIRCLE, C_FILL, C_MARKS, C_OVER, type Backend, type Command, type FramePlan, type Uploaded } from './backend';
import { END_N, LUT_H, LUT_W, discTable, endTable } from './coverage';
import { RECORD_BYTES, type Level } from './scene';
import { UNIFORM_FLOATS, WGSL } from './wgsl';

interface GpuLevel extends Uploaded {
  records: GPUBuffer | null;
  fills: GPUBuffer | null;
}
interface Target { texture: GPUTexture; view: GPUTextureView; bind: GPUBindGroup }

const WIDTHS = 8;
/** Each draw's values sit at a multiple of this in the uniform buffer (the largest alignment a device may ask for). */
const SLOT = 256;

/** What an adapter says it is, for reports. */
export function describe(adapter: GPUAdapter): string {
  const i = adapter.info;
  return ['WebGPU', i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' ');
}

/** True if the adapter draws on the processor. */
export function isFallback(adapter: GPUAdapter): boolean {
  return !!((adapter.info as GPUAdapterInfo & { isFallbackAdapter?: boolean }).isFallbackAdapter || (adapter as GPUAdapter & { isFallbackAdapter?: boolean }).isFallbackAdapter);
}

/**
 * `present` is false where the browser cannot show a WebGPU canvas at all (software
 * rendering in a headless browser): the picture is then only drawn when it is read back.
 */
export async function createWebGPU(canvas: HTMLCanvasElement, adapter: GPUAdapter, present: boolean): Promise<Backend | null> {
  const device = await adapter.requestDevice();
  const format = navigator.gpu.getPreferredCanvasFormat();
  let context: GPUCanvasContext | null = null;
  if (present) {
    context = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!context) { device.destroy(); return null; }
    // the alpha channel is the renderer's scratch register (see the union pass below); every frame ends with it at 1
    context.configure({ device, format, alphaMode: 'premultiplied' });
  }

  const module = device.createShaderModule({ code: WGSL });
  const shared = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: UNIFORM_FLOATS * 4 } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  });
  const fadedLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } }] });
  const plain = device.createPipelineLayout({ bindGroupLayouts: [shared] });
  const withFaded = device.createPipelineLayout({ bindGroupLayouts: [shared, fadedLayout] });

  const PAINT: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } };
  // alpha gathers what the shape leaves uncovered: alpha = cover * (1 - opacity) + alpha * (1 - cover)
  const GATHER: GPUBlendState = { color: { srcFactor: 'zero', dstFactor: 'one' }, alpha: { srcFactor: 'constant', dstFactor: 'one-minus-src-alpha' } };
  // colour = ink * (1 - alpha) + colour * alpha, and alpha goes back to rest at 1
  const LAY: GPUBlendState = { color: { srcFactor: 'one-minus-dst-alpha', dstFactor: 'dst-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'zero' } };
  const records: GPUVertexBufferLayout = {
    arrayStride: RECORD_BYTES, stepMode: 'instance',
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x4' },
      { shaderLocation: 1, offset: 16, format: 'float32x4' },
      { shaderLocation: 2, offset: 32, format: 'float32' },
      { shaderLocation: 3, offset: 36, format: 'uint8x4' },
    ],
  };
  const pipeline = (layout: GPUPipelineLayout, vs: string, fs: string, blend: GPUBlendState, buffers: GPUVertexBufferLayout[], strip: boolean, alphaOnly = false): Promise<GPURenderPipeline> => device.createRenderPipelineAsync({
    layout,
    vertex: { module, entryPoint: vs, buffers },
    fragment: { module, entryPoint: fs, targets: [{ format, blend, writeMask: alphaOnly ? GPUColorWrite.ALPHA : GPUColorWrite.ALL }] },
    primitive: { topology: strip ? 'triangle-strip' : 'triangle-list' },
  });
  // compiled without holding up the page; ready() resolves when all six are
  const pipelines = Promise.all([
    pipeline(plain, 'vs_marks', 'fs_paint', PAINT, [records], true),
    pipeline(plain, 'vs_marks', 'fs_gather', GATHER, [records], true, true),
    pipeline(plain, 'vs_marks', 'fs_lay', LAY, [records], true),
    pipeline(plain, 'vs_fill', 'fs_fill', PAINT, [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }], false),
    pipeline(plain, 'vs_rect', 'fs_circle', PAINT, [], true),
    pipeline(withFaded, 'vs_rect', 'fs_over', PAINT, [], true),
  ]);
  let paint: GPURenderPipeline, gather: GPURenderPipeline, lay: GPURenderPipeline, fill: GPURenderPipeline, circle: GPURenderPipeline, over: GPURenderPipeline;
  let compiled = false;
  const ready = (): Promise<void> => pipelines.then((p) => { [paint, gather, lay, fill, circle, over] = p; compiled = true; });

  // coverage tables: one layer per stroke width
  const table = (w: number, h: number): GPUTexture => device.createTexture({ size: [w, h, WIDTHS], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  const discs = table(LUT_W, LUT_H), rounds = table(END_N, END_N);
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const half = new Float32Array(WIDTHS);

  let slots = 64;
  let uniforms = device.createBuffer({ size: slots * SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  let staging = new Float32Array(slots * SLOT / 4);
  let bind: GPUBindGroup | null = null;
  const bindShared = (): GPUBindGroup => bind || (bind = device.createBindGroup({
    layout: shared,
    entries: [
      { binding: 0, resource: { buffer: uniforms, size: UNIFORM_FLOATS * 4 } },
      { binding: 1, resource: discs.createView({ dimension: '2d-array' }) },
      { binding: 2, resource: rounds.createView({ dimension: '2d-array' }) },
      { binding: 3, resource: sampler },
    ],
  }));

  let width = 1, height = 1;
  const pool: Target[] = [];
  const target = (i: number): Target => {
    while (pool.length <= i) {
      const texture = device.createTexture({ size: [width, height], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      const view = texture.createView();
      pool.push({ texture, view, bind: device.createBindGroup({ layout: fadedLayout, entries: [{ binding: 0, resource: view }] }) });
    }
    return pool[i];
  };
  const dropTargets = (): void => {
    for (const t of pool) t.texture.destroy();
    pool.length = 0;
  };

  let lost: (() => void) | null = null, destroyed = false;
  device.lost.then(() => { if (!destroyed && lost) lost(); });
  let last: FramePlan | null = null;

  /** Writes one draw's values into its slot. */
  const fillSlot = (slot: number, c: Command, ink: number[], paper: number[]): void => {
    const o = slot * SLOT / 4, s = staging;
    s[o] = width; s[o + 1] = height;
    s.set(ink, o + 8); s.set(paper, o + 12);
    for (let i = 16; i < 32; i++) s[o + i] = 0;
    if (c.op === C_MARKS || c.op === C_FILL) { s[o + 4] = c.at[0]; s[o + 5] = c.at[1]; s[o + 6] = c.at[2]; }
    if (c.op === C_MARKS && c.dash) { s[o + 16] = c.dash[0]; s[o + 17] = c.dash[1]; }
    if (c.op === C_CIRCLE) {
      s.set(c.box, o + 20); s.set(c.near, o + 24);
      s[o + 28] = c.radius; s[o + 29] = half[c.width]; s[o + 30] = c.width; s[o + 31] = c.filled ? 1 : 0;
      if (c.dash) { s[o + 16] = c.dash[0]; s[o + 17] = c.dash[1]; s[o + 18] = c.dash[2]; }
      s[o + 19] = c.opacity;
    }
    if (c.op === C_OVER) { s.set(c.box, o + 20); s[o + 28] = c.opacity; }
    s.set(half, o + 32);
  };
  const run = (pass: GPURenderPassEncoder, commands: Command[], first: number): void => {
    const shared0 = bindShared();
    commands.forEach((c, i) => {
      pass.setBindGroup(0, shared0, [(first + i) * SLOT]);
      if (c.op === C_MARKS) {
        const level = c.level as GpuLevel, batch = level.level.batches[c.batch];
        pass.setVertexBuffer(0, level.records!);
        if (c.gather) {
          pass.setPipeline(gather);
          pass.setBlendConstant([0, 0, 0, 1 - c.opacity]);
          pass.draw(4, c.count, 0, batch.first);
          pass.setPipeline(lay);
          pass.draw(4, c.count, 0, batch.first);
        } else {
          pass.setPipeline(paint);
          pass.draw(4, c.count, 0, batch.first);
        }
      } else if (c.op === C_FILL) {
        pass.setPipeline(fill);
        pass.setVertexBuffer(0, (c.level as GpuLevel).fills!);
        pass.draw(c.count, 1, c.first, 0);
      } else if (c.op === C_CIRCLE) {
        pass.setPipeline(circle);
        pass.draw(4);
      } else if (c.op === C_OVER) {
        pass.setPipeline(over);
        pass.setBindGroup(1, target(c.group).bind);
        pass.draw(4);
      }
    });
  };
  const render = (plan: FramePlan, onto: GPUTextureView): void => {
    const total = plan.commands.length + plan.groups.reduce((n, g) => n + g.commands.length, 0);
    if (total > slots) {
      while (slots < total) slots *= 2;
      uniforms.destroy();
      uniforms = device.createBuffer({ size: slots * SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      staging = new Float32Array(slots * SLOT / 4);
      bind = null;
    }
    let slot = 0;
    const starts: number[] = [];
    for (const group of plan.groups) {
      starts.push(slot);
      for (const c of group.commands) fillSlot(slot++, c, [1, 1, 0, 1], [0, 1, 0, 1]);
    }
    const main = slot;
    for (const c of plan.commands) fillSlot(slot++, c, [plan.ink[0], plan.ink[1], plan.ink[2], 1], [1, 1, 1, 1]);
    if (slot) device.queue.writeBuffer(uniforms, 0, staging, 0, slot * SLOT / 4);
    const encoder = device.createCommandEncoder();
    // a layer in mid-fade is drawn on its own first: red gathers its ink, green what it covers, alpha is the register
    plan.groups.forEach((group, i) => {
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target(i).view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
      const b = group.box;
      pass.setScissorRect(b[0], b[1], Math.max(0, b[2] - b[0]), Math.max(0, b[3] - b[1]));
      run(pass, group.commands, starts[i]);
      pass.end();
    });
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: onto, clearValue: { r: 1, g: 1, b: 1, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
    run(pass, plan.commands, main);
    pass.end();
    device.queue.submit([encoder.finish()]);
  };

  return {
    kind: 'webgpu',
    canvas,
    chip: describe(adapter),
    ready,

    resize(w: number, h: number): void {
      if (w === width && h === height && canvas.width === w && canvas.height === h) return;
      width = w; height = h;
      canvas.width = w; canvas.height = h;
      dropTargets();
    },

    setWidths(values: number[]): void {
      const disc = new Uint8Array(LUT_W * LUT_H * WIDTHS), end = new Uint8Array(END_N * END_N * WIDTHS);
      half.fill(0);
      values.slice(0, WIDTHS).forEach((h, i) => {
        half[i] = h;
        discTable(h, disc, i * LUT_W * LUT_H);
        endTable(h, end, i * END_N * END_N);
      });
      device.queue.writeTexture({ texture: discs }, disc, { bytesPerRow: LUT_W, rowsPerImage: LUT_H }, [LUT_W, LUT_H, WIDTHS]);
      device.queue.writeTexture({ texture: rounds }, end, { bytesPerRow: END_N, rowsPerImage: END_N }, [END_N, END_N, WIDTHS]);
    },

    upload(level: Level): Uploaded {
      const make = (data: ArrayBuffer | Float32Array): GPUBuffer | null => {
        if (!data.byteLength) return null;
        const buffer = device.createBuffer({ size: Math.ceil(data.byteLength / 4) * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(buffer, 0, data as ArrayBuffer);
        return buffer;
      };
      const out: GpuLevel = { level, bytes: level.records.byteLength + level.fills.byteLength, records: make(level.records), fills: make(level.fills) };
      return out;
    },

    release(uploaded: Uploaded): void {
      const level = uploaded as GpuLevel;
      if (level.records) level.records.destroy();
      if (level.fills) level.fills.destroy();
    },

    draw(plan: FramePlan): void {
      if (!compiled || destroyed) return;
      last = plan;
      if (context) render(plan, context.getCurrentTexture().createView());
    },

    async read(): Promise<Uint8Array> {
      const out = new Uint8Array(width * height * 4);
      if (!last || !compiled) return out;
      // drawn again into a texture of its own: a canvas cannot be read back, and in software it is not even shown
      const texture = device.createTexture({ size: [width, height], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      render(last, texture.createView());
      const stride = Math.ceil(width * 4 / 256) * 256;
      const buffer = device.createBuffer({ size: stride * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: stride, rowsPerImage: height }, [width, height]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const data = new Uint8Array(buffer.getMappedRange());
      const swap = format.startsWith('bgra');
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = y * stride + 4 * x, o = 4 * (y * width + x);
          out[o] = data[i + (swap ? 2 : 0)]; out[o + 1] = data[i + 1]; out[o + 2] = data[i + (swap ? 0 : 2)]; out[o + 3] = data[i + 3];
        }
      }
      buffer.unmap();
      buffer.destroy();
      texture.destroy();
      return out;
    },

    onLost(callback: () => void): void {
      lost = callback;
    },

    destroy(): void {
      destroyed = true;
      dropTargets();
      device.destroy();
    },
  };
}
