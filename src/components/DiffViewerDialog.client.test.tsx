import { createSignal, type JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { DiffViewerDialog } from './DiffViewerDialog';
import { ChangeTourButton } from './ChangeTourButton';
import { createChangeTour, type ChangeTourController } from '../lib/create-change-tour';
import type { TourStop } from '../lib/change-tour';
import type { ChangedFile } from '../ipc/types';
import { useReview } from './ReviewProvider';
import { store, updateTaskNotes } from '../store/store';
import type { Task } from '../store/types';

const channels = vi.hoisted(
  () =>
    [] as {
      onmessage: ((message: { type: string; text?: string; exitCode?: number }) => void) | null;
      dispose: () => void;
    }[],
);
vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage = null;
    dispose = vi.fn();
    constructor() {
      channels.push(this);
    }
  },
}));
vi.mock('../store/tasks', () => ({ sendPrompt: vi.fn() }));
vi.mock('../store/store', async () => {
  const { createStore } = await import('solid-js/store');
  const [store, setStore] = createStore({
    askCodeProvider: 'claude',
    agentEnvFiles: {},
    tasks: {} as Record<string, Pick<Task, 'id' | 'notes'>>,
  });
  return {
    store,
    updateTaskNotes: vi.fn((id: string, notes: string) => {
      setStore('tasks', id, { id, notes });
    }),
  };
});
vi.mock('./Dialog', () => ({
  Dialog: (props: { children: JSX.Element }) => <div>{props.children}</div>,
}));
vi.mock('./ChangedFilesList', () => ({
  ChangedFilesList: (props: { filesOverride?: ChangedFile[] }) => (
    <div data-testid="file-list">{props.filesOverride?.map((file) => file.path).join(',')}</div>
  ),
}));
vi.mock('./ReviewSidebarPanel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ReviewSidebarPanel')>()),
  ReviewSidebarPanel: () => {
    const review = useReview();
    return (
      <button onClick={() => review.setScrollTarget({ filePath: 'extra.ts', startLine: 1 })}>
        Open outside finding
      </button>
    );
  },
}));
vi.mock('../lib/shiki-highlighter', () => ({
  highlightLines: vi.fn(() => new Promise(() => {})),
  detectLang: () => 'ts',
}));
vi.mock('./ScrollingDiffView', async (importOriginal) => {
  const original = await importOriginal<typeof import('./ScrollingDiffView')>();
  return {
    ScrollingDiffView: (props: Parameters<typeof original.ScrollingDiffView>[0]) => (
      <div
        data-testid="diff-target"
        data-navigation={JSON.stringify(props.scrollToAnnotation)}
        data-files={JSON.stringify(props.files.map((file) => file.path))}
      >
        <original.ScrollingDiffView {...props} />
      </div>
    ),
  };
});
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  channels.length = 0;
});

const diff = 'diff --git a/first.ts b/first.ts\n@@ -1 +1 @@\n-old\n+new\n';
function mount(background = false, rawDiff = diff) {
  vi.mocked(invoke).mockImplementation(async (channel) =>
    channel === IPC.GetAllFileDiffs
      ? rawDiff
      : channel === IPC.GetFileDiff
        ? { newContent: '' }
        : undefined,
  );
  const [target, setTarget] = createSignal<string | null>(background ? null : 'first.ts');
  const [startTour, setStartTour] = createSignal(background);
  let tour!: ChangeTourController;
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => {
    tour = createChangeTour();
    return (
      <>
        {background && (
          <ChangeTourButton
            tour={tour}
            onClick={() => {
              if (tour.stops().length) setTarget('__tour__');
              else void tour.generateForTask({ worktreePath: '/repo', taskName: 'Task' });
            }}
          />
        )}
        <DiffViewerDialog
          tour={tour}
          scrollToFile={target()}
          startTour={startTour()}
          worktreePath="/repo"
          taskId="task"
          onClose={() => setTarget(null)}
        />
      </>
    );
  }, host);
  return { host, setTarget, setStartTour, tour };
}
function complete(
  // The provider's wire shape: tone is optional there.
  stops: Omit<TourStop, 'tone'>[] = [
    {
      title: 'Behavior',
      explanation: 'Changes the value.',
      locations: [{ filePath: 'first.ts', line: 1 }],
    },
  ],
) {
  channels[0].onmessage?.({
    type: 'chunk',
    text: JSON.stringify({
      stops,
    }),
  });
  channels[0].onmessage?.({ type: 'done', exitCode: 0 });
}
it('generates without opening the diff, waits for Start tour, and retains its captured diff across reopening', async () => {
  const { host, setTarget } = mount(true);
  host.querySelector('button')?.click();
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      IPC.AskAboutCode,
      expect.objectContaining({ purpose: 'tour' }),
    ),
  );
  expect(host.querySelector('button[aria-busy="true"] .inline-spinner')).not.toBeNull();
  expect(host.querySelector('[data-testid="diff-target"]')).toBeNull();
  complete();
  expect(host.querySelector('[data-testid="diff-target"]')).toBeNull();
  expect(host.querySelector('button')?.textContent).toContain('Start tour');
  // Work continued while generating. Opening the tour must use its original diff.
  vi.mocked(invoke).mockImplementation(async (channel) =>
    channel === IPC.GetAllFileDiffs
      ? diff.replace('+new', '+later')
      : channel === IPC.GetFileDiff
        ? { newContent: '' }
        : undefined,
  );
  host.querySelector('button')?.click();
  await vi.waitFor(() =>
    expect(host.querySelector('[aria-label="Guided change tour"]')).not.toBeNull(),
  );
  expect(host.querySelector('[aria-label="Tour ready"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="Guided change tour"]')?.textContent).toContain(
    'Changes the value.',
  );
  const tourPanel = host.querySelector('[aria-label="Guided change tour"]');
  expect(host.querySelector('aside')?.firstElementChild).toBe(tourPanel);
  expect(tourPanel?.querySelector('h2')?.textContent).toBe('Behavior');
  expect(host.querySelector('aside')?.style.width).toBe('380px');
  expect(
    [...host.querySelectorAll('button')].filter((button) =>
      button.textContent?.includes('Start tour'),
    ),
  ).toHaveLength(1);
  expect(host.querySelector('aside')?.textContent).not.toContain('Start tour');
  expect(host.querySelector('[data-testid="diff-target"]')?.textContent).toContain('new');
  expect(host.querySelector('[data-testid="diff-target"]')?.textContent).not.toContain('later');
  [...host.querySelectorAll('button')]
    .find((button) => button.textContent === 'Finish tour')
    ?.click();
  expect(host.querySelector('[data-testid="diff-target"]')).toBeNull();
  setTarget('first.ts');
  await vi.waitFor(() => expect(host.querySelector('[aria-label="Tour ready"]')).not.toBeNull());
  expect(
    vi.mocked(invoke).mock.calls.filter(([channel]) => channel === IPC.AskAboutCode),
  ).toHaveLength(1);
  expect(
    vi.mocked(invoke).mock.calls.filter(([channel]) => channel === IPC.GetAllFileDiffs),
  ).toHaveLength(1);
});

it('focuses both views on each step, can reveal all changes, and finishes without losing the tour', async () => {
  const paths = ['first.ts', 'related.ts', 'second.ts', 'extra.ts'];
  const raw = paths.map((path) => diff.replaceAll('first.ts', path)).join('');
  const { host, tour } = mount(true, raw);
  const click = (label: string) => {
    const button = [...host.querySelectorAll('button')].find(
      (element) => element.textContent === label,
    );
    if (!button) throw new Error(`Missing button: ${label}`);
    button.click();
  };
  const displayedPaths = () =>
    JSON.parse(
      host.querySelector('[data-testid="diff-target"]')?.getAttribute('data-files') ?? '[]',
    ) as string[];
  click('Generate tour');
  await vi.waitFor(() => expect(channels).toHaveLength(1));
  complete([
    {
      title: 'Behavior',
      explanation: 'Related changes.',
      locations: [
        { filePath: 'first.ts', line: 1 },
        { filePath: 'related.ts', line: 1 },
      ],
    },
    {
      title: 'Tests',
      explanation: 'Covers the behavior.',
      locations: [{ filePath: 'second.ts', line: 1 }],
    },
  ]);
  host.querySelector('button')?.click();
  await vi.waitFor(() => expect(displayedPaths()).toEqual(['first.ts', 'related.ts']));
  expect(host.querySelector('[data-testid="file-list"]')?.textContent).toBe('first.ts,related.ts');
  expect(host.textContent).toContain('Showing 2 of 4 changed files for this step');
  const search = host.querySelector('input');
  if (!search) throw new Error('Missing search');
  search.value = 'new';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  expect(host.textContent).toContain('2 matches');
  click('Next');
  expect(displayedPaths()).toEqual(['second.ts']);
  expect(host.querySelector('[data-testid="file-list"]')?.textContent).toBe('second.ts');
  expect(host.textContent).toContain('1 matches');
  click('Show all changes');
  expect(displayedPaths()).toEqual(paths);
  expect(host.querySelector('[data-testid="file-list"]')?.textContent).toBe(paths.join(','));
  expect(host.textContent).toContain('4 matches');
  click('Show step files');
  expect(displayedPaths()).toEqual(['second.ts']);
  click('Previous');
  expect(displayedPaths()).toEqual(['first.ts', 'related.ts']);
  click('Open outside finding');
  expect(displayedPaths()).toEqual(paths);
  click('Show step files');
  expect(displayedPaths()).toEqual(['first.ts', 'related.ts']);
  click('Next');
  click('Finish tour');
  expect(host.querySelector('[data-testid="diff-target"]')).toBeNull();
  expect(tour.stops()).toHaveLength(2);
  expect(tour.step()).toBe(0);
  host.querySelector('button')?.click();
  await vi.waitFor(() => expect(displayedPaths()).toEqual(['first.ts', 'related.ts']));
  expect(channels).toHaveLength(1);
});
it('does not show a duplicate tour control in the ordinary changes overlay', async () => {
  const { host } = mount();
  await vi.waitFor(() =>
    expect(host.querySelector('[data-testid="diff-target"]')?.textContent).toContain('new'),
  );
  expect(host.querySelector('aside')?.style.width).toBe('300px');
  expect(host.textContent).not.toContain('Generate tour');
  expect(host.textContent).not.toContain('Start tour');
  expect(vi.mocked(invoke).mock.calls.some(([channel]) => channel === IPC.AskAboutCode)).toBe(
    false,
  );
  expect(host.querySelector('[aria-label="Guided change tour"]')).toBeNull();
});

// The chat's "Review changes" button opens the viewer without a file to focus.
it('loads the whole diff when opened without a file to scroll to', async () => {
  const { host, setTarget, setStartTour } = mount(true);
  setStartTour(false);
  setTarget('');
  await vi.waitFor(() =>
    expect(host.querySelector('[data-testid="diff-target"]')?.getAttribute('data-files')).toBe(
      JSON.stringify(['first.ts']),
    ),
  );
  expect(host.querySelector('h2')?.textContent).toContain('all changes');
});

it('shares task notes with the changed-files dialog and retains edits after reopening', () => {
  updateTaskNotes('task', 'Check error handling');
  const { host, setTarget } = mount();
  const notes = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task notes"]');
  expect(notes?.value).toBe('Check error handling');
  if (!notes) throw new Error('Missing task notes');
  notes.value = 'Add a regression test';
  notes.dispatchEvent(new Event('input', { bubbles: true }));
  expect(updateTaskNotes).toHaveBeenLastCalledWith('task', 'Add a regression test');
  expect(store.tasks.task.notes).toBe('Add a regression test');

  setTarget(null);
  expect(host.querySelector('textarea')).toBeNull();
  setTarget('first.ts');
  expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Add a regression test');

  updateTaskNotes('task', 'Updated outside the dialog');
  expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
    'Updated outside the dialog',
  );
});

it.each(['cancel', 'reset'] as const)('ignores a pending diff load after %s', async (action) => {
  const { host, tour } = mount(true);
  let resolveDiff!: (value: string) => void;
  vi.mocked(invoke).mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        resolveDiff = resolve;
      }),
  );
  host.querySelector('button')?.click();
  expect(host.textContent).toContain('Reading changes');
  expect(host.querySelector('.inline-spinner')).not.toBeNull();
  if (action === 'cancel') host.querySelector('button')?.click();
  else tour.reset();
  resolveDiff(diff);
  await Promise.resolve();
  await Promise.resolve();
  expect(channels).toHaveLength(0);
  expect(host.querySelector('[data-testid="diff-target"]')).toBeNull();
  expect(host.textContent).toContain('Generate tour');
});

it('shows a diff-loading failure inline without opening the viewer and allows retry', async () => {
  const { host } = mount(true);
  vi.mocked(invoke).mockRejectedValueOnce(new Error('Git unavailable'));
  host.querySelector('button')?.click();
  await vi.waitFor(() =>
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Git unavailable'),
  );
  expect(host.querySelector('[data-testid="diff-target"]')).toBeNull();
  expect(host.textContent).toContain('Retry tour');
  host.querySelector('button')?.click();
  await vi.waitFor(() => expect(channels).toHaveLength(1));
});

it('keeps uncaptured context omitted even when the worktree changes', async () => {
  const raw =
    'diff --git a/first.ts b/first.ts\n@@ -2 +2 @@\n-old\n+captured\n@@ -4 +4 @@\n-old\n+captured-again\n';
  const { host } = mount(true, raw);
  host.querySelector('button')?.click();
  await vi.waitFor(() => expect(channels).toHaveLength(1));
  complete([
    {
      title: 'Change',
      explanation: 'Captured changes.',
      locations: [{ filePath: 'first.ts', line: 2 }],
    },
  ]);
  vi.mocked(invoke).mockImplementation(async (channel) =>
    channel === IPC.GetFileDiff
      ? { newContent: 'LATER_CONTEXT\nnew\nLATER_CONTEXT\nnew\nLATER_CONTEXT\n' }
      : undefined,
  );
  host.querySelector('button')?.click();
  await vi.waitFor(() => expect(host.querySelectorAll('[data-line-type="add"]')).toHaveLength(2));
  const gaps = [...host.querySelectorAll('div')].filter(
    (el) => el.children.length === 0 && el.textContent?.includes('not captured'),
  );
  expect(gaps).toHaveLength(3);
  gaps.forEach((gap) => gap.click());
  expect(host.textContent).not.toContain('LATER_CONTEXT');
  expect(vi.mocked(invoke).mock.calls.some(([channel]) => channel === IPC.GetFileDiff)).toBe(false);
});

it.each(['old', 'new'] as const)(
  'scrolls to and highlights the cited %s-side line',
  async (side) => {
    // happy-dom rejects color-mix backgrounds; inspect the applied declaration.
    const setProperty = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty');
    const raw =
      'diff --git a/first.ts b/first.ts\n' +
      (side === 'old'
        ? 'deleted file mode 100644\n@@ -1,2 +0,0 @@\n-first\n-second\n'
        : 'new file mode 100644\n@@ -0,0 +1,2 @@\n+first\n+second\n');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return new DOMRect(0, this.getAttribute(`data-${side}-line`) === '2' ? 400 : 0, 100, 20);
    });
    const { host } = mount(true, raw);
    host.querySelector('button')?.click();
    await vi.waitFor(() => expect(channels).toHaveLength(1));
    complete([
      {
        title: 'Change',
        explanation: 'Second line.',
        locations: [{ filePath: 'first.ts', line: 2 }],
      },
    ]);
    host.querySelector('button')?.click();
    await vi.waitFor(() => expect(host.querySelectorAll('[data-line-type]')).toHaveLength(2));
    const rows = host.querySelectorAll<HTMLElement>('[data-line-type]');
    expect(
      setProperty.mock.calls.some(
        (args, index) =>
          setProperty.mock.contexts[index] === rows[1].style &&
          args[0] === 'background' &&
          args[1]?.includes('var(--search-match-active)'),
      ),
    ).toBe(true);
    expect(
      setProperty.mock.calls.some(
        (args, index) =>
          setProperty.mock.contexts[index] === rows[0].style &&
          args[0] === 'background' &&
          args[1]?.includes('var(--search-match-active)'),
      ),
    ).toBe(false);
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="diff-target"]')?.firstElementChild?.scrollTop).toBe(
        320,
      ),
    );
  },
);

it('uses the project directory for generation after a missing-worktree fallback', async () => {
  const { tour } = mount(true);
  vi.mocked(invoke).mockImplementation(async (channel) => {
    if (channel === IPC.GetAllFileDiffs) throw new Error('Missing worktree');
    if (channel === IPC.GetAllFileDiffsFromBranch) return diff;
    return undefined;
  });
  await tour.generateForTask({
    worktreePath: '/missing',
    projectRoot: '/repo',
    branchName: 'task',
    taskName: 'Task',
  });
  expect(invoke).toHaveBeenCalledWith(
    IPC.AskAboutCode,
    expect.objectContaining({ cwd: '/repo', provider: 'claude' }),
  );
});

it.each([
  {
    branchName: 'feature/tour',
    selectedCommit: 'abc123',
    channel: IPC.GetCommitDiffs,
    baseBranch: 'develop',
  },
  {
    branchName: 'feature/tour',
    selectedCommit: 'uncommitted',
    channel: IPC.GetUncommittedFileDiffs,
    baseBranch: 'feature/tour',
  },
  {
    branchName: 'develop',
    selectedCommit: null,
    channel: IPC.GetAllFileDiffs,
    baseBranch: 'main',
  },
  {
    branchName: 'feature/direct',
    selectedCommit: null,
    channel: IPC.GetAllFileDiffs,
    baseBranch: undefined,
  },
] as const)(
  'generates the currently selected diff: $branchName / $selectedCommit',
  async (input) => {
    const { tour } = mount(true);
    vi.mocked(invoke).mockImplementation(async (channel) =>
      channel === input.channel ? diff : undefined,
    );
    await tour.generateForTask({ worktreePath: '/repo', taskName: 'Task', ...input });
    const gitCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([channel]) => channel !== IPC.AskAboutCode);
    expect(gitCalls).toHaveLength(1);
    expect(gitCalls[0][0]).toBe(input.channel);
    if (input.channel === IPC.GetAllFileDiffs)
      expect(gitCalls[0][1]?.baseBranch).toBe(input.baseBranch);
    if (input.channel === IPC.GetCommitDiffs)
      expect(gitCalls[0][1]?.commitHash).toBe(input.selectedCommit);
    expect(invoke).toHaveBeenCalledWith(
      IPC.AskAboutCode,
      expect.objectContaining({ prompt: expect.stringContaining(JSON.stringify(diff)) }),
    );
  },
);

it('keeps a generated tour while browsing another scope with live context', async () => {
  const { host, tour, setTarget, setStartTour } = mount(true);
  host.querySelector('button')?.click();
  await vi.waitFor(() => expect(channels).toHaveLength(1));
  complete();
  vi.mocked(invoke).mockImplementation(async (channel) => {
    if (channel === IPC.GetAllFileDiffs)
      return diff.replace('@@ -1 +1 @@', '@@ -2 +2 @@').replace('+new', '+later');
    if (channel === IPC.GetFileDiff) return { newContent: 'live context\nlater\n' };
    return undefined;
  });
  setStartTour(false);
  setTarget('first.ts');
  await vi.waitFor(() => expect(host.textContent).toContain('live context'));
  expect(tour.stops()).toHaveLength(1);
  expect(tour.sourceDiff()).toBe(diff);
  expect(host.querySelector('[aria-label="Guided change tour"]')).toBeNull();
});

it('navigates to the cited old-side line and exposes the return label', async () => {
  vi.mocked(invoke).mockImplementation(async (channel) =>
    channel === IPC.GetAllFileDiffs ? diff : undefined,
  );
  const close = vi.fn();
  dispose = render(
    () => (
      <DiffViewerDialog
        scrollToFile="first.ts"
        scrollToLine={1}
        scrollToSide="old"
        closeLabel="Back to evidence"
        worktreePath="/repo"
        onClose={close}
      />
    ),
    document.body,
  );
  await vi.waitFor(() =>
    expect(
      document.querySelector('[data-testid="diff-target"]')?.getAttribute('data-navigation'),
    ).toContain('"side":"old"'),
  );
  expect(
    JSON.parse(
      document.querySelector('[data-testid="diff-target"]')?.getAttribute('data-navigation') ??
        '{}',
    ),
  ).toEqual({ filePath: 'first.ts', startLine: 1, side: 'old' });
  document.querySelector<HTMLButtonElement>('[aria-label="Back to evidence"]')?.click();
  expect(close).toHaveBeenCalledOnce();
});
