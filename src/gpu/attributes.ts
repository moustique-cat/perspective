// Shared by the page (which finds out what the device can do before fetching anything) and
// the WebGL2 backend (which then uses the very context the page made).

/** The alpha channel is the renderer's scratch register; every frame ends with it at 1 everywhere. */
export const GL_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
  preserveDrawingBuffer: false, desynchronized: false,
};

/** What the browser says it draws WebGL with. */
export function rendererOf(gl: WebGL2RenderingContext): string {
  const plain = String(gl.getParameter(gl.RENDERER));
  // Chromium and Safari only name the chip through an extension; Firefox names it outright (and warns about the extension)
  const ext = /^(WebKit WebGL|Mozilla)?$/.test(plain) ? gl.getExtension('WEBGL_debug_renderer_info') : null;
  return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : plain;
}

/** True if a renderer's name is that of software drawing on the processor, not a graphics chip. */
export function isSoftware(renderer: string): boolean {
  return /swiftshader|llvmpipe|software|softpipe|basic render/i.test(renderer);
}
