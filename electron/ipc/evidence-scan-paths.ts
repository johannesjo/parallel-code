import type { EvidenceFileRole, EvidenceTestKind } from '../shared/evidence.js';

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

export function isSnapshotPath(path: string): boolean {
  return path.endsWith('.snap') || path.includes('__snapshots__/');
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Classifies a repo-relative path by how it can influence a check run. */
export function classifyPath(path: string): EvidenceFileRole {
  // Snapshots have their own rule; treating them as execution surface too would double-flag.
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

export function testKind(path: string): EvidenceTestKind {
  return /(?:^|\/)e2e(?:\/|$)|playwright|\.e2e\.|cypress/i.test(path) ? 'e2e' : 'unit';
}

/** `foo.test.ts`, `foo_test.go`, `test_foo.py` and `foo.tsx` all map to `foo`. */
export function subjectBase(path: string): string {
  return basename(path)
    .replace(/\.[^.]+$/, '')
    .replace(/\.(?:test|spec|e2e)$/, '')
    .replace(/_test$/, '')
    .replace(/^test_/, '');
}
