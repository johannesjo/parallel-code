import path from 'path';
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

const rootDir = path.resolve(process.cwd());
const siblingWorktreesDir = path.resolve(rootDir, '..');

export default defineConfig({
  base: './',
  plugins: [solid()],
  clearScreen: false,
  server: {
    port: 1421,
    strictPort: true,
    watch: {
      ignored: (watchedPath) => {
        const resolvedPath = path.resolve(watchedPath);
        return resolvedPath.startsWith(siblingWorktreesDir) && !resolvedPath.startsWith(rootDir);
      },
    },
  },
});
