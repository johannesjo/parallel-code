import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const TEST_PATHSPECS = [
  ':(glob)**/*.test.*',
  ':(glob)**/*.spec.*',
  ':(glob)**/__tests__/**',
  ':(glob)**/*_test.go',
  ':(glob)**/test_*.py',
  ':(glob)**/*_test.py',
];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Bare module name; `index` is too generic to match by name. */
function moduleName(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  return name && name !== 'index' ? name : undefined;
}

function importsModule(content: string, name: string): boolean {
  const token = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`);
  return content
    .split('\n')
    .some((line) => /\b(?:import|from|require)\b/.test(line) && token.test(line));
}

async function testsMentioning(cwd: string, head: string, name: string): Promise<string[]> {
  const out = await git(cwd, ['grep', '-l', '-F', '-e', name, head, '--', ...TEST_PATHSPECS]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(head.length + 1));
}

async function confirmedTests(
  cwd: string,
  head: string,
  source: string,
  exclude: Set<string>,
): Promise<string[]> {
  const name = moduleName(source);
  if (!name) return [];
  const candidates = (await testsMentioning(cwd, head, name)).filter((t) => !exclude.has(t));
  const confirmed = await Promise.all(
    candidates.map((test) =>
      git(cwd, ['show', `${head}:${test}`]).then((content) => importsModule(content, name)),
    ),
  );
  return candidates.filter((_, index) => confirmed[index]);
}

/**
 * Unchanged test files that import each changed source file, best effort by
 * module name. Any git failure for a file yields no coverage for it, never an error.
 */
export async function findCoveringTests(
  cwd: string,
  head: string,
  sources: string[],
  changedPaths: Set<string>,
): Promise<Array<{ testFile: string; sources: string[] }>> {
  const byTest = new Map<string, string[]>();
  const results = await Promise.all(
    sources.map((source) => confirmedTests(cwd, head, source, changedPaths).catch(() => [])),
  );
  results.forEach((tests, index) => {
    for (const test of tests) byTest.set(test, [...(byTest.get(test) ?? []), sources[index]]);
  });
  return [...byTest].map(([testFile, covered]) => ({ testFile, sources: covered }));
}
