import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  entry: [
    'electron/main.ts',
    'electron/preload.cjs',
    'electron/mcp/server.ts',
    'src/investigation/demo/dev.tsx',
  ],
  project: ['electron/**/*.ts', 'src/**/*.{ts,tsx}'],
  ignoreBinaries: [
    // Optional security tooling invoked from npm scripts; installed on demand.
    'semgrep',
    'gitleaks',
    // Shell builtin, not a binary: the build script sets `umask 022` so files the
    // packaging targets generate are world-readable (see scripts/after-pack.cjs).
    'umask',
  ],
  // Test files are allowed to have unused exports (test helpers, fixtures).
  ignoreExportsUsedInFile: true,
};

export default config;
