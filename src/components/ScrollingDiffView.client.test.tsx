import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '../lib/ipc';
import { LARGE_DIFF_FILE_THRESHOLD, LARGE_DIFF_LINE_THRESHOLD } from '../lib/diff-collapse';
import type { DiffLine, FileDiff } from '../lib/unified-diff-parser';
import { ReviewProvider } from './ReviewProvider';
import { ScrollingDiffView } from './ScrollingDiffView';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
vi.mock('../store/tasks', () => ({ sendPrompt: vi.fn() }));
vi.mock('../lib/shiki-highlighter', () => ({
  highlightLines: vi.fn(() => new Promise(() => {})),
  detectLang: () => 'ts',
}));

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  vi.mocked(invoke).mockReset();
});

function file(path: string, changedLines: number): FileDiff {
  const lines: DiffLine[] = Array.from({ length: changedLines }, (_, i) => ({
    type: 'add' as const,
    content: `line ${i}`,
    oldLine: null,
    newLine: i + 1,
  }));
  return {
    path,
    status: 'M',
    binary: false,
    hunks: [{ oldStart: 1, oldCount: 0, newStart: 1, newCount: lines.length, lines }],
  };
}

function mount(files: FileDiff[], scrollToPath: string | null): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  disposers.push(
    render(
      () => (
        <ReviewProvider open compilePrompt={() => ''}>
          <ScrollingDiffView files={files} scrollToPath={scrollToPath} worktreePath="/wt" />
        </ReviewProvider>
      ),
      host,
    ),
  );
  return host;
}

/** Paths of the files that ended up rendering diff rows. */
function renderedFiles(host: HTMLElement): string[] {
  const paths = new Set<string>();
  for (const row of host.querySelectorAll('[data-line-type]')) {
    const path = row.getAttribute('data-file-path');
    if (path) paths.add(path);
  }
  return [...paths].sort();
}

/** Files whose surrounding context was fetched over IPC. */
function contextFetchedFiles(): Set<string> {
  const paths = new Set<string>();
  for (const call of vi.mocked(invoke).mock.calls) {
    const args = call[1] as { filePath?: string } | undefined;
    if (args?.filePath) paths.add(args.filePath);
  }
  return paths;
}

describe('ScrollingDiffView large-diff collapsing', () => {
  it('renders rows for the target file only when the diff is long', () => {
    const host = mount(
      [file('a.ts', LARGE_DIFF_LINE_THRESHOLD + 1), file('b.ts', 20), file('c.ts', 20)],
      'b.ts',
    );
    expect(renderedFiles(host)).toEqual(['b.ts']);
  });

  it('renders rows for the target file only when the diff is wide but shallow', () => {
    const files = Array.from({ length: LARGE_DIFF_FILE_THRESHOLD + 1 }, (_, i) =>
      file(`f${i}.ts`, 2),
    );
    const host = mount(files, 'f5.ts');
    expect(renderedFiles(host)).toEqual(['f5.ts']);
  });

  it('does not fetch surrounding context for collapsed files', () => {
    mount([file('a.ts', LARGE_DIFF_LINE_THRESHOLD + 1), file('b.ts', 20)], 'b.ts');
    expect(contextFetchedFiles()).toEqual(new Set(['b.ts']));
  });

  it('renders every file when the diff is small', () => {
    const host = mount([file('a.ts', 10), file('b.ts', 10)], 'a.ts');
    expect(renderedFiles(host)).toEqual(['a.ts', 'b.ts']);
  });

  it('falls back to the first file when the target is not part of the diff', () => {
    const host = mount([file('a.ts', LARGE_DIFF_LINE_THRESHOLD + 1), file('b.ts', 20)], 'gone.ts');
    expect(renderedFiles(host)).toEqual(['a.ts']);
  });
});
