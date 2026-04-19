import path from 'path';
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

const rootDir = path.resolve(process.cwd());
const parentDir = path.resolve(rootDir, '..');

export default defineConfig({
  base: './',
  plugins: [solid()],
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
