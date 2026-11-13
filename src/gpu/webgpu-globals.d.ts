// The WebGPU constant tables, which this TypeScript version's DOM library leaves out
// (it has the interfaces). Only the entries the renderer uses.
declare const GPUBufferUsage: { readonly MAP_READ: number; readonly COPY_SRC: number; readonly COPY_DST: number; readonly VERTEX: number; readonly UNIFORM: number };
declare const GPUTextureUsage: { readonly COPY_SRC: number; readonly COPY_DST: number; readonly TEXTURE_BINDING: number; readonly RENDER_ATTACHMENT: number };
declare const GPUShaderStage: { readonly VERTEX: number; readonly FRAGMENT: number };
declare const GPUColorWrite: { readonly ALPHA: number; readonly ALL: number };
declare const GPUMapMode: { readonly READ: number };
