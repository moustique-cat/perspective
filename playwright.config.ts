import { defineConfig } from '@playwright/test';

const port = 4173;
/** WebGL drawn by SwiftShader on the processor; the page itself composited in software as before. */
const SOFTWARE = ['--use-angle=swiftshader-webgl'];

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 240_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: 'chromium',
    // The caption crossfade and the start-up fades are switched off by the design's own
    // reduced-motion rules, so a screenshot never catches one half way.
    reducedMotion: 'reduce',
    trace: 'off',
  },
  projects: [
    {
      // The site against the original design. Drawn in software on every machine, so that
      // the pictures are the same everywhere and the page stays with its SVG: with WebGL on
      // SwiftShader the site sees no graphics chip and fetches no renderer.
      name: 'design',
      testMatch: /(original|site)\.spec\.ts/,
      use: { launchOptions: { args: SOFTWARE } },
    },
    {
      // The renderer against the SVG, also in software: the renderer is asked for by address.
      name: 'renderer',
      testMatch: /(renderer|widths)\.spec\.ts/,
      use: { launchOptions: { args: [...SOFTWARE, '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'] } },
    },
    {
      // What only a real graphics chip can show. Each test launches its own browser and
      // skips itself on a machine without one.
      name: 'chip',
      testMatch: /chip\.spec\.ts/,
    },
  ],
  webServer: {
    command: 'node e2e/serve.mjs',
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: !process.env.CI,
    env: { PORT: String(port) },
  },
});
