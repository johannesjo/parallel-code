import type { ScanFileRole } from '../shared/checks.js';

const SOURCE_EXT =
  /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|swift|vue|svelte|c|cc|cpp|h|hpp|scala|dart|ex|exs)$/;

const TEST_NAME = [
  /\.(?:test|spec)\.[^/]+$/,
  /_test\.(?:go|py)$/,
  /(?:^|\/)test_[^/]*\.py$/,
  /(?:^|\/)__tests__\//,
];

const LOCKFILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'go.sum',
]);

const EXEC_BASENAMES = new Set([
  'package.json',
  'conftest.py',
  'pytest.ini',
  'tox.ini',
  'pyproject.toml',
  'Makefile',
  'REVIEW.md',
  'Cargo.toml',
  'go.mod',
  '.npmrc',
]);

const EXEC_NAME = [
  /\.config\.[^/]+$/,
  /^tsconfig[^/]*\.json$/,
  /\.setup\.[^/]+$/,
  /^setupTests\.[^/]+$/,
  /^\.env/,
];

const EXEC_DIR = /(?:^|\/)(?:__mocks__|__fixtures__|fixtures|tests?|e2e)\//;

function isSnapshotPath(path: string): boolean {
  return path.endsWith('.snap') || path.includes('__snapshots__/');
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Classifies a repo-relative path by how it can influence a check run. */
export function classifyPath(path: string): ScanFileRole {
  // Snapshots are recorded output, not something that changes how checks run.
  if (isSnapshotPath(path)) return 'other';
  if (TEST_NAME.some((pattern) => pattern.test(path))) return 'test';
  const name = basename(path);
  if (
    LOCKFILES.has(name) ||
    EXEC_BASENAMES.has(name) ||
    EXEC_NAME.some((pattern) => pattern.test(name)) ||
    path.startsWith('.github/workflows/') ||
    EXEC_DIR.test(path)
  )
    return 'execution-surface';
  return SOURCE_EXT.test(name) ? 'source' : 'other';
}
