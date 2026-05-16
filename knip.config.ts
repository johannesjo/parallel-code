import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  entry: [
    'electron/main.ts',
    'electron/preload.cjs',
    'electron/mcp/server.ts', // added in coordinator-2-mcp-backend; listed here so knip tracks it from the start
    'src/main.tsx',
    'src/remote/main.tsx',
  ],
  project: ['electron/**/*.ts', 'src/**/*.{ts,tsx}'],
  ignore: [
    'dist/**',
    'dist-electron/**',
    'dist-remote/**',
    'release/**',
    'scripts/**',
    // Vite/Electron configs are entry points picked up by their respective tools
    'electron/vite.config.electron.ts',
    'electron/vite.config.electron.test.ts',
    'electron/shims/**',
  ],
  ignoreDependencies: [
    // Peer dependencies and indirect runtime deps
    'electron',
    'electron-builder',
    'concurrently',
    'wait-on',
  ],
  // Test files are allowed to have unused exports (test helpers, fixtures)
  ignoreExportsUsedInFile: true,
};

export default config;
