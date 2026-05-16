/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-renderer-importing-main',
      severity: 'error',
      comment:
        'Renderer (src/) must never import Electron main-process code. ' +
        'Use IPC channels instead.',
      from: { path: '^src/' },
      to: {
        path: '^electron/',
        // Allow importing the shared IPC channel enum (channels.ts is a pure enum, no Node/Electron deps)
        pathNot: '^electron/ipc/channels\\.ts',
      },
    },
    {
      name: 'no-mcp-importing-components',
      severity: 'error',
      comment: 'MCP coordinator must not import frontend components or store.',
      from: { path: '^electron/mcp/' },
      to: { path: '^src/(components|store|lib)/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Circular dependencies break tree-shaking and make reasoning about startup order impossible.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Orphan modules have no importers and no exports used elsewhere — likely dead code.',
      from: {
        orphan: true,
        // Test files, config files, entry points, and pure type modules are expected orphans.
        // Type-only modules (types.ts, *.d.ts) are consumed by TypeScript structurally — the
        // import graph doesn't capture all type-level usage, so they appear orphaned.
        pathNot: [
          '\\.test\\.(ts|tsx)$',
          '\\.config\\.(ts|js|cjs)$',
          '\\.d\\.ts$',
          'types\\.ts$',
          'types\\.(ts|tsx)$',
          '^src/main\\.tsx$',
          '^src/remote/main\\.tsx$',
          '^electron/main\\.ts$',
          '^electron/preload\\.cjs$',
          '^electron/mcp/server\\.ts$',
          // New subsystem files have no importers until coordinator PRs land
          '^electron/mcp/atomic\\.ts$',
          // Vite ambient env declarations
          '^src/vite-env\\.d\\.ts$',
        ],
      },
      to: {},
    },
  ],

  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    moduleSystems: ['es6', 'cjs'],
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    reporterOptions: {
      dot: {
        collapsePattern: 'node_modules/[^/]+',
      },
      archi: {
        collapsePattern: '^(node_modules|src/components)/[^/]+',
      },
    },
  },
};
