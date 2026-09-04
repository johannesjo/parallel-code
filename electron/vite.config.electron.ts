import path from 'path';
import { defineConfig, type Plugin } from 'vite';
import solid from 'vite-plugin-solid';

const rootDir = path.resolve(process.cwd());
const parentDir = path.resolve(rootDir, '..');

/**
 * Content-Security-Policy for the packaged renderer. The renderer can spawn
 * processes through IPC, so any script injection in it is code execution on
 * the user's machine; the policy makes sure only the bundle itself runs.
 *
 * - script-src: the bundle plus 'wasm-unsafe-eval' for shiki's oniguruma
 *   engine (WebAssembly instantiation is blocked without it).
 * - style-src 'unsafe-inline': Solid `style={{}}` attributes plus the style
 *   elements xterm, Monaco, and mermaid inject.
 * - img-src https:: images in rendered markdown (notes, plans).
 * - worker-src blob:: Monaco language workers.
 *
 * Applied at build time only: the dev server injects its own client and HMR
 * socket, which this policy would block.
 */
export const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
].join('; ');

function rendererCspPlugin(): Plugin {
  return {
    name: 'parallel-code:renderer-csp',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: RENDERER_CSP },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [solid(), rendererCspPlugin()],
  clearScreen: false,
  server: {
    port: 1421,
    strictPort: true,
    watch: {
      // Creating git worktrees inside this repo would otherwise look like a giant
      // source-tree change to Vite in dev mode, causing the renderer to reload
      // right when Parallel Code creates a task for itself. The function ignores
      // anything resolving outside the project root (e.g. host parent dirs).
      ignored: [
        '**/.worktrees/**',
        (watchedPath: string) => {
          const resolvedPath = path.resolve(watchedPath);
          return resolvedPath.startsWith(parentDir) && !resolvedPath.startsWith(rootDir);
        },
      ],
    },
  },
});
