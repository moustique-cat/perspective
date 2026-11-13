// The WebGL2 backend: for devices without WebGPU.
import { GL_ATTRIBUTES, rendererOf } from './attributes';
import { C_CIRCLE, C_FILL, C_MARKS, C_OVER, type Backend, type Box, type Command, type FramePlan, type Uploaded } from './backend';
import { END_N, LUT_H, LUT_W, discTable, endTable } from './coverage';
import { CIRCLE_FS, FILL_FS, FILL_VS, MARKS_FS, MARKS_VS, OVER_FS, RECT_VS } from './glsl';
import { B_FILL, RECORD_BYTES, type Level } from './scene';

interface GlLevel extends Uploaded {
  records: WebGLBuffer | null;
  fills: WebGLBuffer | null;
  /** One vertex array per batch, pointing at that batch's records or triangles. */
  arrays: (WebGLVertexArrayObject | null)[];
}

interface Program {
  program: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

interface Target { texture: WebGLTexture; frame: WebGLFramebuffer }

const WIDTHS = 8;
const PAINT = 0, GATHER = 1, LAY = 2;

export function createWebGL2(canvas: HTMLCanvasElement): Backend | null {
  // the page may already have made this context, with these same attributes, to see what the device draws with
  const gl = canvas.getContext('webgl2', GL_ATTRIBUTES);
  if (!gl) return null;
  const chip = rendererOf(gl);
  const parallel = gl.getExtension('KHR_parallel_shader_compile');

  const compile = (vs: string, fs: string, uniforms: string[]): Program => {
    const program = gl.createProgram()!;
    for (const [type, source] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    return { program, u: Object.fromEntries(uniforms.map((name) => [name, null])) };
  };
  const marks = compile(MARKS_VS, MARKS_FS, ['u_xf', 'u_view', 'u_half', 'u_dash', 'u_color', 'u_mode', 'u_disc', 'u_ends']);
  const fill = compile(FILL_VS, FILL_FS, ['u_xf', 'u_view', 'u_color']);
  const circle = compile(RECT_VS, CIRCLE_FS, ['u_rect', 'u_view', 'u_near', 'u_shape', 'u_color', 'u_paper', 'u_dash', 'u_disc', 'u_ends']);
  const over = compile(RECT_VS, OVER_FS, ['u_rect', 'u_view', 'u_layer', 'u_color', 'u_paper', 'u_opacity']);
  const programs = [marks, fill, circle, over];

  let linked = false;
  const finish = (): void => {
    if (linked) return;
    for (const p of programs) {
      if (!gl.getProgramParameter(p.program, gl.LINK_STATUS) && !gl.isContextLost()) {
        const shaders = gl.getAttachedShaders(p.program) || [];
        throw new Error('shader: ' + (gl.getProgramInfoLog(p.program) || '') + shaders.map((s) => gl.getShaderInfoLog(s) || '').join('\n'));
      }
      for (const name of Object.keys(p.u)) p.u[name] = gl.getUniformLocation(p.program, name);
    }
    linked = true;
  };
  const ready = (): Promise<void> => new Promise((resolve, reject) => {
    const poll = (): void => {
      try {
        // asking for the link status before it is known would stall the page while the driver compiles
        if (parallel && !programs.every((p) => gl.getProgramParameter(p.program, parallel.COMPLETION_STATUS_KHR))) { setTimeout(poll, 8); return; }
        finish();
        resolve();
      } catch (e) {
        reject(e);
      }
    };
    poll();
  });

  // coverage tables: one layer per stroke width
  const table = (unit: number, w: number, h: number): WebGLTexture => {
    const t = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R8, w, h, WIDTHS);
    for (const [name, value] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D_ARRAY, name, value);
    return t;
  };
  const discs = table(0, LUT_W, LUT_H), ends = table(1, END_N, END_N);
  const half = new Float32Array(WIDTHS);

  const quad = gl.createVertexArray();
  let width = 1, height = 1;
  const pool: Target[] = [];
  let lost: (() => void) | null = null;
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); if (lost) lost(); });

  const target = (i: number): Target => {
    while (pool.length <= i) {
      const texture = gl.createTexture()!, frame = gl.createFramebuffer()!;
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, frame);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      pool.push({ texture, frame });
    }
    return pool[i];
  };
  const dropTargets = (): void => {
    for (const t of pool) { gl.deleteTexture(t.texture); gl.deleteFramebuffer(t.frame); }
    pool.length = 0;
  };

  const blend = (mode: number, opacity = 1): void => {
    if (mode === PAINT) {
      gl.colorMask(true, true, true, true);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    } else if (mode === GATHER) {
      // alpha gathers what the shape leaves uncovered: alpha = cover * (1 - opacity) + alpha * (1 - cover)
      gl.colorMask(false, false, false, true);
      gl.blendColor(0, 0, 0, 1 - opacity);
      gl.blendFuncSeparate(gl.ZERO, gl.ONE, gl.CONSTANT_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      // colour = ink * (1 - alpha) + colour * alpha, and alpha goes back to rest at 1
      gl.colorMask(true, true, true, true);
      gl.blendFuncSeparate(gl.ONE_MINUS_DST_ALPHA, gl.DST_ALPHA, gl.ONE, gl.ZERO);
    }
  };

  let current: Program | null = null;
  const use = (p: Program): Program => {
    if (current !== p) { gl.useProgram(p.program); current = p; }
    return p;
  };

  /** Draws one list of commands into the bound target; `ink` and `paper` are what the two colours mean there. */
  const run = (commands: Command[], ink: number[], paper: number[]): void => {
    for (const c of commands) {
      if (c.op === C_MARKS) {
        const level = c.level as GlLevel;
        const p = use(marks);
        gl.bindVertexArray(level.arrays[c.batch]);
        gl.uniform3f(p.u.u_xf, c.at[0], c.at[1], c.at[2]);
        gl.uniform3f(p.u.u_dash, c.dash ? c.dash[0] : 0, c.dash ? c.dash[1] : 0, 0);
        gl.uniform4f(p.u.u_color, ink[0], ink[1], ink[2], ink[3]);
        if (c.gather) {
          blend(GATHER, c.opacity);
          gl.uniform1i(p.u.u_mode, 1);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, c.count);
          blend(LAY);
          gl.uniform1i(p.u.u_mode, 2);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, c.count);
          blend(PAINT);
        } else {
          gl.uniform1i(p.u.u_mode, 0);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, c.count);
        }
      } else if (c.op === C_FILL) {
        const level = c.level as GlLevel;
        const p = use(fill);
        // one array covers all the level's triangles; the batch is a range of it
        gl.bindVertexArray(level.arrays[level.arrays.length - 1]);
        gl.uniform3f(p.u.u_xf, c.at[0], c.at[1], c.at[2]);
        gl.uniform4f(p.u.u_color, paper[0], paper[1], paper[2], paper[3]);
        gl.drawArrays(gl.TRIANGLES, c.first, c.count);
      } else if (c.op === C_CIRCLE) {
        const p = use(circle);
        gl.bindVertexArray(quad);
        gl.uniform4f(p.u.u_rect, c.box[0], c.box[1], c.box[2], c.box[3]);
        gl.uniform4f(p.u.u_near, c.near[0], c.near[1], c.near[2], c.near[3]);
        gl.uniform4f(p.u.u_shape, c.radius, half[c.width], c.width, c.filled ? 1 : 0);
        gl.uniform4f(p.u.u_color, ink[0], ink[1], ink[2], ink[3]);
        gl.uniform4f(p.u.u_paper, paper[0], paper[1], paper[2], paper[3]);
        gl.uniform4f(p.u.u_dash, c.dash ? c.dash[0] : 0, c.dash ? c.dash[1] : 0, c.dash ? c.dash[2] : 0, c.opacity);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      } else if (c.op === C_OVER) {
        const p = use(over);
        gl.bindVertexArray(quad);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, target(c.group).texture);
        gl.uniform4f(p.u.u_rect, c.box[0], c.box[1], c.box[2], c.box[3]);
        gl.uniform4f(p.u.u_color, ink[0], ink[1], ink[2], ink[3]);
        gl.uniform4f(p.u.u_paper, paper[0], paper[1], paper[2], paper[3]);
        gl.uniform1f(p.u.u_opacity, c.opacity);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }
  };

  const perFrame = (): void => {
    for (const p of [marks, circle]) {
      use(p);
      gl.uniform2f(p.u.u_view, width, height);
      gl.uniform1i(p.u.u_disc, 0);
      gl.uniform1i(p.u.u_ends, 1);
      if (p === marks) gl.uniform1fv(p.u.u_half, half);
    }
    use(fill);
    gl.uniform2f(fill.u.u_view, width, height);
    use(over);
    gl.uniform2f(over.u.u_view, width, height);
    gl.uniform1i(over.u.u_layer, 2);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, discs);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, ends);
  };

  return {
    kind: 'webgl2',
    canvas,
    chip,
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
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, discs);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, LUT_W, LUT_H, WIDTHS, gl.RED, gl.UNSIGNED_BYTE, disc);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, ends);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, END_N, END_N, WIDTHS, gl.RED, gl.UNSIGNED_BYTE, end);
    },

    upload(level: Level): Uploaded {
      const out: GlLevel = { level, bytes: level.records.byteLength + level.fills.byteLength, records: null, fills: null, arrays: [] };
      if (level.count) {
        out.records = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, out.records);
        gl.bufferData(gl.ARRAY_BUFFER, level.records, gl.STATIC_DRAW);
      }
      for (const b of level.batches) {
        if (b.kind === B_FILL) { out.arrays.push(null); continue; }
        const array = gl.createVertexArray();
        gl.bindVertexArray(array);
        gl.bindBuffer(gl.ARRAY_BUFFER, out.records);
        const base = b.first * RECORD_BYTES;
        gl.vertexAttribPointer(0, 4, gl.FLOAT, false, RECORD_BYTES, base);
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, RECORD_BYTES, base + 16);
        gl.vertexAttribPointer(2, 1, gl.FLOAT, false, RECORD_BYTES, base + 32);
        gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, false, RECORD_BYTES, base + 36);
        for (let i = 0; i < 4; i++) { gl.enableVertexAttribArray(i); gl.vertexAttribDivisor(i, 1); }
        out.arrays.push(array);
      }
      // last: the array for the triangles
      if (level.fills.length) {
        out.fills = gl.createBuffer();
        const array = gl.createVertexArray();
        gl.bindVertexArray(array);
        gl.bindBuffer(gl.ARRAY_BUFFER, out.fills);
        gl.bufferData(gl.ARRAY_BUFFER, level.fills, gl.STATIC_DRAW);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
        gl.enableVertexAttribArray(0);
        out.arrays.push(array);
      } else {
        out.arrays.push(null);
      }
      gl.bindVertexArray(null);
      return out;
    },

    release(uploaded: Uploaded): void {
      const level = uploaded as GlLevel;
      gl.deleteBuffer(level.records);
      gl.deleteBuffer(level.fills);
      for (const a of level.arrays) gl.deleteVertexArray(a);
      level.arrays.length = 0;
    },

    draw(plan: FramePlan): void {
      finish();
      current = null;
      perFrame();
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.viewport(0, 0, width, height);
      blend(PAINT);
      // a layer in mid-fade is drawn on its own first: red gathers its ink, green what it covers, alpha is the register
      const scissor = (box: Box): void => gl.scissor(box[0], height - box[3], Math.max(0, box[2] - box[0]), Math.max(0, box[3] - box[1]));
      plan.groups.forEach((group, i) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target(i).frame);
        gl.enable(gl.SCISSOR_TEST);
        scissor(group.box);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        run(group.commands, [1, 1, 0, 1], [0, 1, 0, 1]);
      });
      gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.clearColor(1, 1, 1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      run(plan.commands, [plan.ink[0], plan.ink[1], plan.ink[2], 1], [1, 1, 1, 1]);
      gl.bindVertexArray(null);
    },

    read(): Promise<Uint8Array> {
      const raw = new Uint8Array(width * height * 4), out = new Uint8Array(width * height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
      // WebGL's rows run bottom to top
      for (let y = 0; y < height; y++) out.set(raw.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
      return Promise.resolve(out);
    },

    onLost(callback: () => void): void {
      lost = callback;
    },

    destroy(): void {
      lost = null;
      dropTargets();
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    },
  };
}
