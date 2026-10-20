/**
 * Pure integrity rules over a parsed diff (no fs, no git). See
 * docs/evidence-packages.md, "Integrity scan".
 */
import {
  EVIDENCE_LIMITS,
  type EvidenceFileChange,
  type EvidenceFlag,
  type EvidenceFlagCategory,
  type EvidenceScan,
  type EvidenceTestChange,
} from '../shared/evidence.js';
import { classifyPath, isSnapshotPath, subjectBase, testKind } from './evidence-scan-paths.js';
import { extractTitle, hashText, parseHunks, type ParsedHunks } from './evidence-scan-lines.js';

export { classifyPath, testKind } from './evidence-scan-paths.js';
export { extractTitle } from './evidence-scan-lines.js';

export interface DiffFileInput {
  path: string;
  oldPath?: string;
  status: 'A' | 'M' | 'D' | 'R';
  added: number;
  removed: number;
  /** Unified diff text for this file; header lines before the first hunk are ignored. */
  patch: string;
}

export interface AnalyzeInput {
  files: DiffFileInput[];
  /** Unchanged test files and the changed source files each one imports. */
  coveringTests: Array<{ testFile: string; sources: string[] }>;
}

type AnalyzeResult = Pick<
  EvidenceScan,
  'files' | 'flags' | 'tests' | 'sourceWithoutTests' | 'coveringTests' | 'truncated'
>;

interface Entry extends DiffFileInput {
  role: EvidenceFileChange['role'];
  hunks: ParsedHunks;
}

const RANK: Record<EvidenceFlagCategory, number> = {
  'test-weakened': 0,
  'needs-decision': 1,
  info: 2,
};

// `.only` is here because it silently disables the rest of the suite.
const DISABLE = [
  /\.(?:skip|only|todo|fixme)\s*\(/,
  /\b(?:xit|xdescribe)\s*\(/,
  /@pytest\.mark\.skip/,
  /@unittest\.skip/,
  /\bt\.Skip\(/,
];
const TEST_ENV = [
  /process\.env\.NODE_ENV\s*[!=]==?\s*['"]test['"]/,
  /process\.env\.(?:VITEST|JEST_WORKER_ID)\b/,
  /import\.meta\.env\.VITEST\b/,
  /import\.meta\.vitest\b/,
  /PYTEST_CURRENT_TEST/,
];
const BROAD_CATCH = [
  /\bcatch\s*(?:\(\s*\w*\s*\))?\s*\{\s*\}/,
  /\bcatch\s*\{\s*(?:\/\/.*)?$/,
  /\bcatch\s*\(\s*\w*\s*\)\s*\{\s*return\b/,
  /^\s*except\s*:/,
  /^\s*except\s+Exception(?:\s+as\s+\w+)?\s*:\s*(?:pass)?\s*$/,
];
const ASSERTION = /\bexpect\(|\bassert\w*\s*[.(\s]/;
const MOCK_CALL = /\b(?:vi|jest)\.(?:mock|doMock)\(\s*['"`]([^'"`]+)['"`]/;
const SPY_CALL = /\b(?:vi|jest)\.spyOn\(|\bvi\.stubGlobal\(/;

function makeFlag(
  rule: string,
  category: EvidenceFlagCategory,
  file: string,
  content: string,
  detail: string,
  line?: number,
): EvidenceFlag {
  return {
    id: `${rule}:${hashText(`${rule}\0${file}\0${content}`)}`,
    category,
    rule,
    file,
    ...(line !== undefined && { line }),
    detail,
  };
}

function fileLevelFlags(entry: Entry, deletedSourceBases: Set<string>): EvidenceFlag[] {
  const { path, role, status } = entry;
  const flags: EvidenceFlag[] = [];
  if (role === 'test' && status === 'D') {
    const withSource = deletedSourceBases.has(subjectBase(path));
    flags.push(
      withSource
        ? makeFlag(
            'test-deleted-with-source',
            'info',
            path,
            path,
            'Test file deleted together with the code it tests.',
          )
        : makeFlag(
            'test-file-deleted',
            'test-weakened',
            path,
            path,
            'Test file deleted while its subject still exists.',
          ),
    );
  }
  if (role === 'execution-surface')
    flags.push(
      makeFlag(
        'execution-surface-changed',
        'needs-decision',
        path,
        entry.patch,
        'Changes how checks run or what they run against.',
      ),
    );
  if (isSnapshotPath(path))
    flags.push(
      makeFlag('snapshot-updated', 'needs-decision', path, path, 'Snapshot file was updated.'),
    );
  return flags;
}

function matchingLines(
  entry: Entry,
  patterns: RegExp[],
  rule: string,
  category: EvidenceFlagCategory,
  detail: string,
): EvidenceFlag[] {
  return entry.hunks.added
    .filter(({ text }) => patterns.some((pattern) => pattern.test(text)))
    .map(({ line, text }) => makeFlag(rule, category, entry.path, text.trim(), detail, line));
}

function mockFlags(entry: Entry, changedSourceBases: Set<string>): EvidenceFlag[] {
  const flags: EvidenceFlag[] = [];
  for (const { line, text } of entry.hunks.added) {
    const target = MOCK_CALL.exec(text)?.[1];
    if (target && changedSourceBases.has(subjectBase(target)))
      flags.push(
        makeFlag(
          'mock-of-changed-module',
          'info',
          entry.path,
          text.trim(),
          `Mocks ${target}, which this change modifies.`,
          line,
        ),
      );
  }
  const spy = entry.hunks.added.find(({ text }) => SPY_CALL.test(text));
  if (spy)
    flags.push(
      makeFlag(
        'mock-of-changed-module',
        'info',
        entry.path,
        'spy',
        'Adds spies or global stubs.',
        spy.line,
      ),
    );
  return flags;
}

function assertionFlag(entry: Entry): EvidenceFlag[] {
  const count = (lines: { text: string }[]) => lines.filter((l) => ASSERTION.test(l.text)).length;
  const removed = count(entry.hunks.removed);
  const added = count(entry.hunks.added);
  if (entry.status === 'D' || removed - added < 2) return [];
  return [
    makeFlag(
      'assertion-count-dropped',
      'info',
      entry.path,
      `${removed}>${added}`,
      `Assertions dropped from ${removed} removed to ${added} added lines.`,
    ),
  ];
}

function lineFlags(entry: Entry, changedSourceBases: Set<string>): EvidenceFlag[] {
  if (entry.role === 'test') {
    return [
      ...matchingLines(
        entry,
        DISABLE,
        'test-disabled',
        'test-weakened',
        'Disables a test or the rest of its suite.',
      ),
      ...mockFlags(entry, changedSourceBases),
      ...assertionFlag(entry),
    ];
  }
  if (entry.role !== 'source') return [];
  return [
    ...matchingLines(
      entry,
      TEST_ENV,
      'test-env-branch',
      'needs-decision',
      'Source behaves differently under test.',
    ),
    ...matchingLines(
      entry,
      BROAD_CATCH,
      'broad-catch-added',
      'info',
      'Broad or empty catch can hide failures.',
    ),
  ];
}

function titlesOf(lines: { line: number; text: string }[]) {
  return lines.flatMap(({ line, text }) => {
    const title = extractTitle(text);
    return title === undefined ? [] : [{ title, line, text }];
  });
}

function testChanges(entries: Entry[]): { tests: EvidenceTestChange[]; flags: EvidenceFlag[] } {
  const testEntries = entries.filter((e) => e.role === 'test');
  const added = new Map(testEntries.map((e) => [e.path, titlesOf(e.hunks.added)]));
  const allAdded = new Set([...added.values()].flatMap((list) => list.map((t) => t.title)));
  const tests: EvidenceTestChange[] = [];
  const flags: EvidenceFlag[] = [];
  for (const entry of testEntries) {
    const kind = testKind(entry.path);
    const addedHere = added.get(entry.path) ?? [];
    const addedTitles = new Set(addedHere.map((t) => t.title));
    const removedHere = titlesOf(entry.hunks.removed);
    const removedTitles = new Set(removedHere.map((t) => t.title));
    const push = (title: string, change: EvidenceTestChange['change']) =>
      tests.push({ file: entry.path, kind, title, change });
    for (const title of addedTitles) push(title, removedTitles.has(title) ? 'changed' : 'added');
    for (const { title, line, text } of removedHere) {
      if (addedTitles.has(title)) continue;
      push(title, allAdded.has(title) ? 'changed' : 'removed');
      if (entry.status !== 'D' && !allAdded.has(title))
        flags.push(
          makeFlag(
            'test-removed',
            'test-weakened',
            entry.path,
            text.trim(),
            `Test removed: ${title}`,
            line,
          ),
        );
    }
  }
  return { tests, flags };
}

function sourceWithoutTests(entries: Entry[], covered: Set<string>): string[] {
  const testedBases = new Set(
    entries.filter((e) => e.role === 'test' && e.status !== 'D').map((e) => subjectBase(e.path)),
  );
  return entries
    .filter((e) => e.role === 'source' && e.status !== 'D')
    .filter((e) => !testedBases.has(subjectBase(e.path)) && !covered.has(e.path))
    .map((e) => e.path);
}

function cap<T>(list: T[], max: number, cut: { value: boolean }): T[] {
  if (list.length <= max) return list;
  cut.value = true;
  return list.slice(0, max);
}

/** Applies every integrity rule to the cumulative diff and caps the lists. */
export function analyzeDiff(input: AnalyzeInput): AnalyzeResult {
  const entries: Entry[] = input.files.map((f) => ({
    ...f,
    role: classifyPath(f.path),
    hunks: parseHunks(f.patch),
  }));
  const deletedSourceBases = new Set(
    entries.filter((e) => e.role === 'source' && e.status === 'D').map((e) => subjectBase(e.path)),
  );
  const changedSourceBases = new Set(
    entries.filter((e) => e.role === 'source' && e.status !== 'D').map((e) => subjectBase(e.path)),
  );
  const titles = testChanges(entries);
  const flags = [
    ...entries.flatMap((e) => fileLevelFlags(e, deletedSourceBases)),
    ...entries.flatMap((e) => lineFlags(e, changedSourceBases)),
    ...titles.flags,
  ].sort((a, b) => RANK[a.category] - RANK[b.category]);
  const covered = new Set(input.coveringTests.flatMap((c) => c.sources));
  const cut = { value: false };
  return {
    files: cap(
      entries.map(({ path, oldPath, status, added, removed, role }) => ({
        path,
        ...(oldPath !== undefined && { oldPath }),
        status,
        added,
        removed,
        role,
      })),
      EVIDENCE_LIMITS.maxFiles,
      cut,
    ),
    flags: cap(flags, EVIDENCE_LIMITS.maxFlags, cut),
    tests: cap(titles.tests, EVIDENCE_LIMITS.maxTests, cut),
    coveringTests: cap(
      input.coveringTests.map((c) => c.testFile),
      EVIDENCE_LIMITS.maxCovering,
      cut,
    ),
    sourceWithoutTests: cap(sourceWithoutTests(entries, covered), EVIDENCE_LIMITS.maxFiles, cut),
    ...(cut.value && { truncated: true }),
  };
}
