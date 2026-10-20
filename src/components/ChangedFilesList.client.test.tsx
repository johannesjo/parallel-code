import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import type { ChangedFile, CoverageSummary } from '../ipc/types';
import type { CoverageComparison } from '../lib/coverage-comparison';
import { invoke } from '../lib/ipc';
import type { UnderstandingTourState } from '../lib/create-understanding-tour';
import { startWindowVisibilityTracking } from '../lib/windowVisibility';
import { UNCOMMITTED_SELECTION } from './CommitNavBar';
import { ChangedFilesList } from './ChangedFilesList';

vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(),
}));

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  vi.mocked(invoke).mockReset();
});

function coverageSummary(repoRoot: string, pct: number): CoverageSummary {
  return {
    format: 'istanbul-summary',
    generatedAt: '2026-08-01T12:00:00.000Z',
    reportPath: `${repoRoot}/coverage/coverage-summary.json`,
    totals: {
      lines: { total: 100, covered: pct, skipped: 0, pct },
      statements: { total: 100, covered: pct, skipped: 0, pct },
      functions: { total: 10, covered: Math.round(pct / 10), skipped: 0, pct },
      branches: { total: 20, covered: Math.round(pct / 5), skipped: 0, pct },
    },
    files: {
      'src/example.ts': {
        path: 'src/example.ts',
        lines: { total: 100, covered: pct, skipped: 0, pct },
        statements: { total: 100, covered: pct, skipped: 0, pct },
        functions: { total: 10, covered: Math.round(pct / 10), skipped: 0, pct },
        branches: { total: 20, covered: Math.round(pct / 5), skipped: 0, pct },
      },
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for mounted ChangedFilesList state');
}

describe('ChangedFilesList markdown canvas button', () => {
  it('shows the canvas button on markdown rows only and opens the file on click', async () => {
    const files: ChangedFile[] = [
      { path: 'docs/notes.md', status: 'M', lines_added: 1, lines_removed: 0, committed: false },
      { path: 'src/example.ts', status: 'M', lines_added: 1, lines_removed: 0, committed: false },
      { path: 'docs/old.md', status: 'D', lines_added: 0, lines_removed: 3, committed: false },
    ];
    const onOpenMarkdownClick = vi.fn();
    vi.mocked(invoke).mockImplementation(((channel: string) => {
      if (channel === IPC.GetUncommittedChangedFiles) return Promise.resolve(files);
      return Promise.reject(new Error(`Unexpected IPC call: ${channel}`));
    }) as typeof invoke);

    const container = document.createElement('div');
    document.body.append(container);
    disposers.push(
      render(
        () => (
          <ChangedFilesList
            worktreePath="/task"
            isActive
            selectedCommit={UNCOMMITTED_SELECTION}
            onOpenMarkdownClick={onOpenMarkdownClick}
          />
        ),
        container,
      ),
    );

    await waitFor(() => container.querySelector('.changed-files-open-canvas-btn') !== null);

    const canvasButton = container.querySelector<HTMLButtonElement>(
      '.changed-files-open-canvas-btn',
    );
    const mdRow = canvasButton?.closest('.file-row');
    expect(mdRow?.querySelector('span[title="docs/notes.md"]')).not.toBeNull();
    const tsRow = [...container.querySelectorAll('.file-row')].find((row) =>
      row.querySelector('span[title="src/example.ts"]'),
    );
    expect(tsRow?.querySelector('.changed-files-open-canvas-btn')).toBeNull();
    expect(tsRow?.querySelector('.changed-files-open-editor-btn')).not.toBeNull();
    const deletedRow = [...container.querySelectorAll('.file-row')].find((row) =>
      row.querySelector('span[title="docs/old.md"]'),
    );
    expect(deletedRow?.querySelector('.changed-files-open-canvas-btn')).toBeNull();

    canvasButton?.click();
    expect(onOpenMarkdownClick).toHaveBeenCalledTimes(1);
    expect(onOpenMarkdownClick.mock.calls[0][0]).toMatchObject({ path: 'docs/notes.md' });
  });

  it('hides the canvas button without a handler', async () => {
    const files: ChangedFile[] = [
      { path: 'docs/notes.md', status: 'M', lines_added: 1, lines_removed: 0, committed: false },
    ];
    vi.mocked(invoke).mockImplementation(((channel: string) => {
      if (channel === IPC.GetUncommittedChangedFiles) return Promise.resolve(files);
      return Promise.reject(new Error(`Unexpected IPC call: ${channel}`));
    }) as typeof invoke);

    const container = document.createElement('div');
    document.body.append(container);
    disposers.push(
      render(
        () => (
          <ChangedFilesList worktreePath="/task" isActive selectedCommit={UNCOMMITTED_SELECTION} />
        ),
        container,
      ),
    );

    await waitFor(() => container.querySelector('.file-row') !== null);
    expect(container.querySelector('.changed-files-open-canvas-btn')).toBeNull();
    expect(container.querySelector('.changed-files-open-editor-btn')).not.toBeNull();
  });
});

describe('ChangedFilesList understand button', () => {
  const files: ChangedFile[] = [
    { path: 'src/example.ts', status: 'M', lines_added: 1, lines_removed: 0, committed: false },
    { path: 'src/gone.ts', status: 'D', lines_added: 0, lines_removed: 4, committed: false },
  ];

  function showHint(button: HTMLElement): HTMLElement {
    button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    const hint = document.querySelector<HTMLElement>('[role="tooltip"]');
    if (!hint) throw new Error('No tour hint shown');
    return hint;
  }

  function mountList(options: {
    onUnderstandClick?: (file: ChangedFile) => void;
    onFileClick?: () => void;
    understanding?: UnderstandingTourState;
  }) {
    vi.mocked(invoke).mockImplementation(((channel: string) => {
      if (channel === IPC.GetUncommittedChangedFiles) return Promise.resolve(files);
      return Promise.reject(new Error(`Unexpected IPC call: ${channel}`));
    }) as typeof invoke);
    const container = document.createElement('div');
    document.body.append(container);
    disposers.push(
      render(
        () => (
          <ChangedFilesList
            worktreePath="/task"
            isActive
            selectedCommit={UNCOMMITTED_SELECTION}
            onUnderstandClick={options.onUnderstandClick}
            onFileClick={options.onFileClick}
            understanding={options.understanding}
          />
        ),
        container,
      ),
    );
    return container;
  }

  /** Only src/example.ts survives the D-status filter, so it owns the only button. */
  const understandButton = (container: HTMLElement) => {
    const button = container.querySelector<HTMLButtonElement>('.changed-files-understand-btn');
    if (!button) throw new Error('Understand button is missing');
    return button;
  };

  it('offers a tour on existing files only and does not open the diff', async () => {
    const onUnderstandClick = vi.fn();
    const onFileClick = vi.fn();
    const container = mountList({ onUnderstandClick, onFileClick });

    await waitFor(() => container.querySelector('.changed-files-understand-btn') !== null);

    const buttons = container.querySelectorAll('.changed-files-understand-btn');
    expect(buttons.length).toBe(1);
    const button = buttons[0] as HTMLButtonElement;
    expect(
      button.closest('.file-row')?.querySelector('span[title="src/example.ts"]'),
    ).not.toBeNull();
    expect(button.getAttribute('aria-label')).toBe('Understand src/example.ts');
    expect(button.title).toBe('');

    button.click();
    expect(onUnderstandClick).toHaveBeenCalledTimes(1);
    expect(onUnderstandClick.mock.calls[0][0]).toMatchObject({ path: 'src/example.ts' });
    expect(onFileClick).not.toHaveBeenCalled();
  });

  it('hides the understand button without a handler', async () => {
    const container = mountList({});
    await waitFor(() => container.querySelector('.file-row') !== null);
    expect(container.querySelector('.changed-files-understand-btn')).toBeNull();
  });

  it('shows the spinner only on the row whose tour is generating', async () => {
    const container = mountList({
      onUnderstandClick: vi.fn(),
      understanding: {
        isLoading: (kind, subject) => kind === 'file' && subject === 'src/other.ts',
        isReady: () => false,
      },
    });
    await waitFor(() => container.querySelector('.changed-files-understand-btn') !== null);

    const button = understandButton(container);
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(button.querySelector('.inline-spinner')).toBeNull();
    expect(button.querySelector('svg')).not.toBeNull();
    const hint = showHint(button);
    expect(hint.textContent).toContain('src/example.ts');
    expect(hint.textContent).toContain('reads the file and its direct imports');
  });

  it('replaces the icon with a spinner while its own tour generates', async () => {
    const container = mountList({
      onUnderstandClick: vi.fn(),
      understanding: {
        isLoading: (kind, subject) => kind === 'file' && subject === 'src/example.ts',
        isReady: () => false,
      },
    });
    await waitFor(() => container.querySelector('.changed-files-understand-btn') !== null);

    const button = understandButton(container);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelector('.inline-spinner')).not.toBeNull();
    expect(button.querySelector('svg')).toBeNull();
    expect(showHint(button).textContent).toContain('Click to cancel.');
  });

  it('marks a finished tour as ready to open on its own row', async () => {
    const container = mountList({
      onUnderstandClick: vi.fn(),
      understanding: {
        isLoading: () => false,
        isReady: (kind, subject) => kind === 'file' && subject === 'src/example.ts',
      },
    });
    await waitFor(() => container.querySelector('.changed-files-understand-btn') !== null);

    const button = understandButton(container);
    expect(showHint(button).textContent).toContain('Click to open it.');
    // The row keeps a ready tour visible without hover; CSS keys on this.
    expect(button.dataset.ready).toBe('true');
    expect(button.parentElement?.classList.contains('changed-files-understand-anchor')).toBe(true);
    expect(button.style.color).not.toBe('');
  });
});

describe('ChangedFilesList coverage inventory fallbacks', () => {
  it('uses a tour inventory without polling live files or coverage', () => {
    const file: ChangedFile = {
      path: 'captured.ts',
      status: 'M',
      lines_added: 1,
      lines_removed: 1,
      committed: false,
    };
    const onFileClick = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    disposers.push(
      render(
        () => (
          <ChangedFilesList
            worktreePath="/task"
            isActive
            filesOverride={[file]}
            onFileClick={onFileClick}
          />
        ),
        container,
      ),
    );
    expect(container.textContent).toContain('captured.ts');
    (container.querySelector('.file-row') as HTMLElement).click();
    expect(onFileClick).toHaveBeenCalledWith(file);
    expect(invoke).not.toHaveBeenCalled();
  });
  it.each(['loading', 'failed'] as const)(
    'suppresses per-file comparison output while inventory is %s',
    async (inventoryState) => {
      const changedFile: ChangedFile = {
        path: 'src/example.ts',
        lines_added: 1,
        lines_removed: 0,
        status: 'M',
        committed: false,
      };
      const taskCoverage = coverageSummary('/task', 60);
      const baseCoverage = coverageSummary('/base', 80);

      vi.mocked(invoke).mockImplementation(((channel: string, args?: Record<string, unknown>) => {
        if (channel === IPC.GetUncommittedChangedFiles) {
          return Promise.resolve([changedFile]);
        }
        if (channel === IPC.GetChangedFiles) {
          return inventoryState === 'loading'
            ? new Promise<ChangedFile[]>(() => undefined)
            : Promise.reject(new Error('inventory unavailable'));
        }
        if (channel === IPC.GetBranchWorktreePath) {
          const branchName = args?.branchName;
          return Promise.resolve(
            branchName === 'main'
              ? { path: '/base', headCommittedAt: '2026-08-01T11:00:00.000Z' }
              : { path: '/task', headCommittedAt: '2026-08-01T11:00:00.000Z' },
          );
        }
        if (channel === IPC.GetCoverageSummary) {
          return Promise.resolve(args?.repoRoot === '/base' ? baseCoverage : taskCoverage);
        }
        return Promise.reject(new Error(`Unexpected IPC call: ${channel}`));
      }) as typeof invoke);

      const container = document.createElement('div');
      document.body.append(container);
      const state: { latestComparison: CoverageComparison | null } = { latestComparison: null };
      disposers.push(
        render(
          () => (
            <ChangedFilesList
              worktreePath="/task"
              projectRoot="/project"
              branchName="task"
              baseBranch="main"
              isActive
              selectedCommit={UNCOMMITTED_SELECTION}
              onCoverageComparisonChange={(comparison) => {
                state.latestComparison = comparison;
              }}
            />
          ),
          container,
        ),
      );

      await waitFor(
        () =>
          state.latestComparison?.inventoryState === inventoryState &&
          container.textContent.includes('base 80%'),
      );

      expect(state.latestComparison?.aggregate.delta).toBe(-20);
      expect(Object.keys(state.latestComparison?.files ?? {})).toEqual([]);
      expect(state.latestComparison?.impactedUnchangedFiles).toEqual([]);
      expect(container.textContent).toContain('base 80% → task 60% (-20pp)');
      expect(container.querySelector('[title^="Lines 60%"]')).not.toBeNull();
      expect(container.textContent).not.toContain('↕');
    },
  );
});

describe('ChangedFilesList polling', () => {
  it('skips polls while the window is hidden and resumes once it is shown', async () => {
    let emitVisibility: ((visible: unknown) => void) | undefined;
    vi.stubGlobal('electron', {
      ipcRenderer: {
        on: (channel: string, listener: (visible: unknown) => void) => {
          if (channel === IPC.WindowVisibilityChanged) emitVisibility = listener;
          return () => undefined;
        },
      },
    });
    const stopTracking = startWindowVisibilityTracking();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const polls = () =>
        vi.mocked(invoke).mock.calls.filter(([ch]) => ch === IPC.GetUncommittedChangedFiles).length;
      vi.mocked(invoke).mockImplementation(((channel: string) => {
        if (channel === IPC.GetUncommittedChangedFiles) return Promise.resolve([]);
        return Promise.reject(new Error(`Unexpected IPC call: ${channel}`));
      }) as typeof invoke);
      const container = document.createElement('div');
      document.body.append(container);
      disposers.push(
        render(
          () => (
            <ChangedFilesList
              worktreePath="/task"
              isActive
              selectedCommit={UNCOMMITTED_SELECTION}
            />
          ),
          container,
        ),
      );
      await waitFor(() => polls() === 1);
      // Let the first refresh settle; an in-flight refresh drops later ticks.
      await new Promise((resolve) => setTimeout(resolve, 0));

      emitVisibility?.(false);
      vi.advanceTimersByTime(15_000);
      expect(polls()).toBe(1);

      emitVisibility?.(true);
      vi.advanceTimersByTime(5_000);
      expect(polls()).toBe(2);
    } finally {
      emitVisibility?.(true);
      stopTracking();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
