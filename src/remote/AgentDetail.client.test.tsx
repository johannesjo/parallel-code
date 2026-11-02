import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { AgentDetail } from './AgentDetail';
import { fetchMergeReadiness, fetchNotes, fetchTaskDiff, mergeTask, closeTask } from './api';
import { agents, scrollAgent, sendInput } from './ws';
import type { RemoteAgent } from '../../electron/remote/protocol';

const terminalMocks = vi.hoisted(() => ({
  scrollLines: vi.fn(),
  scrollToBottom: vi.fn(),
  refresh: vi.fn(),
  options: { fontSize: 14 },
  scrollback: undefined as ((data: string, cols: number, rows: number) => void) | undefined,
  terminalSize: undefined as ((cols: number, rows: number) => void) | undefined,
  bufferType: 'normal' as 'normal' | 'alternate',
  element: undefined as HTMLElement | undefined,
  lines: [] as string[],
  viewportY: 100,
  baseY: 100,
  bufferChange: undefined as (() => void) | undefined,
  scrolled: undefined as (() => void) | undefined,
  rendered: undefined as (() => void) | undefined,
  // xterm draws scrolled rows on its next frame; hold the draw to see what shows meanwhile.
  holdRender: false,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: true };
    options = terminalMocks.options;
    buffer = {
      active: {
        get type() {
          return terminalMocks.bufferType;
        },
        get length() {
          return terminalMocks.lines.length;
        },
        get viewportY() {
          return terminalMocks.viewportY;
        },
        get baseY() {
          return terminalMocks.baseY;
        },
        getLine: (i: number) => {
          const text = terminalMocks.lines[i];
          return text === undefined
            ? undefined
            : { isWrapped: false, translateToString: () => text };
        },
      },
      onBufferChange: (listener: () => void) => {
        terminalMocks.bufferChange = listener;
        return { dispose() {} };
      },
    };
    get element() {
      return terminalMocks.element;
    }
    open() {}
    refresh(start: number, end: number) {
      terminalMocks.refresh(start, end);
    }
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }
    onScroll(listener: () => void) {
      terminalMocks.scrolled = listener;
      return { dispose() {} };
    }
    onRender(listener: () => void) {
      terminalMocks.rendered = listener;
      return { dispose() {} };
    }
    onWriteParsed() {
      return { dispose() {} };
    }
    dispose() {}
    reset() {}
    write(_data: Uint8Array, callback?: () => void) {
      callback?.();
    }
    scrollLines(lines: number) {
      terminalMocks.scrollLines(lines);
      terminalMocks.viewportY = Math.max(
        0,
        Math.min(terminalMocks.baseY, terminalMocks.viewportY + lines),
      );
      terminalMocks.scrolled?.();
      if (!terminalMocks.holdRender) terminalMocks.rendered?.();
    }
    scrollToBottom() {
      terminalMocks.scrollToBottom();
      terminalMocks.viewportY = terminalMocks.baseY;
    }
  },
}));
const wsMocks = vi.hoisted(() => ({ canControl: true }));

const READY_MERGE = {
  readiness: { overall: 'ready' as const, checks: [] },
  canMerge: true,
  baseBranch: 'main',
  branchName: 'task/thing',
};

vi.mock('./ws', () => ({
  agents: vi.fn<() => RemoteAgent[]>(),
  status: () => 'connected',
  canControl: () => wsMocks.canControl,
  reconnect: vi.fn(),
  subscribeAgent: vi.fn(),
  unsubscribeAgent: vi.fn(),
  sendInput: vi.fn(),
  scrollAgent: vi.fn(),
  onOutput: () => () => {},
  onScrollback: (_id: string, callback: (data: string, cols: number, rows: number) => void) => {
    terminalMocks.scrollback = callback;
    return () => {};
  },
  onTerminalSize: (_id: string, callback: (cols: number, rows: number) => void) => {
    terminalMocks.terminalSize = callback;
    return () => {};
  },
}));
vi.mock('./api', () => ({
  fetchNotes: vi.fn().mockResolvedValue('Notes from desktop'),
  saveNotes: vi.fn(),
  fetchTaskDiff: vi.fn().mockResolvedValue({ diff: '', truncated: false }),
  fetchMergeReadiness: vi.fn().mockResolvedValue({
    readiness: { overall: 'ready', checks: [] },
    canMerge: true,
    baseBranch: 'main',
    branchName: 'task/thing',
  }),
  mergeTask: vi.fn().mockResolvedValue(undefined),
  closeTask: vi.fn().mockResolvedValue(undefined),
  fetchFixCiPrompt: vi.fn().mockResolvedValue('CI failed on pull request #7.'),
  sendFixCiPrompt: vi.fn(),
  ApiError: class extends Error {},
}));

let host: HTMLDivElement;
let dispose: () => void;
const onNextTask = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks drops queued one-shot values too, but re-establish the
  // defaults so each test starts from a known API state.
  vi.mocked(fetchNotes).mockResolvedValue('Notes from desktop');
  vi.mocked(fetchTaskDiff).mockResolvedValue({ diff: '', truncated: false });
  vi.mocked(fetchMergeReadiness).mockResolvedValue(READY_MERGE);
  vi.mocked(mergeTask).mockResolvedValue(undefined);
  vi.mocked(closeTask).mockResolvedValue({ warnings: [] });
  wsMocks.canControl = true;
  vi.mocked(agents)
    .mockReset()
    .mockReturnValue([
      {
        agentId: 'a1',
        taskId: 't1',
        taskName: 'First task',
        status: 'running',
        attention: 'needs_input',
        exitCode: null,
        lastLine: '',
      },
    ]);
  terminalMocks.options.fontSize = 14;
  terminalMocks.bufferType = 'normal';
  terminalMocks.element = undefined;
  terminalMocks.lines = [];
  terminalMocks.viewportY = 100;
  terminalMocks.baseY = 100;
  terminalMocks.holdRender = false;
  localStorage.clear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  dispose?.();
  host.remove();
  vi.restoreAllMocks();
});
function mount(agentId = 'a1', onBack: () => void = () => {}) {
  dispose = render(
    () => (
      <AgentDetail
        agentId={agentId}
        taskName="First task"
        onBack={onBack}
        onNeedsPairing={() => {}}
        onNextTask={onNextTask}
      />
    ),
    host,
  );
}
function composer() {
  const field = host.querySelector<HTMLTextAreaElement>('[aria-label="Message agent"]');
  if (!field) throw new Error('Missing composer');
  return field;
}
function tab(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('nav button')].find(
    (b) => b.textContent === label,
  );
  if (!button) throw new Error(`Missing ${label} tab`);
  return button;
}
async function openTab(label: string) {
  tab(label).click();
  await Promise.resolve();
  await Promise.resolve();
}
function dialogButton(label: string) {
  const button = [
    ...host.querySelectorAll<HTMLButtonElement>('.mobile-dialog-actions button'),
  ].find((b) => b.textContent === label);
  if (!button) throw new Error(`Missing dialog button: ${label}`);
  return button;
}
async function openMergeDialog() {
  host.querySelector<HTMLButtonElement>('.mobile-diff-actions')?.click();
  await vi.waitFor(() => expect(host.querySelector('.mobile-dialog')).not.toBeNull());
}
function type(text: string) {
  composer().value = text;
  composer().dispatchEvent(new Event('input', { bubbles: true }));
}
function bashButton() {
  const button = host.querySelector<HTMLButtonElement>('[aria-label="Shell command mode"]');
  if (!button) throw new Error('Missing shell command button');
  return button;
}
function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === text);
  if (!button) throw new Error(`Missing button: ${text}`);
  button.click();
}

describe('phone reply composer', () => {
  it('resizes a restored multiline reply after returning from Notes', async () => {
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockReturnValue(120);
    localStorage.setItem('parallel-mobile:reply:a1', 'First line\nSecond line\nThird line');
    mount();
    await vi.waitFor(() => expect(composer().style.height).toBe('120px'));
    click('Notes');
    click('Terminal');
    await vi.waitFor(() => expect(composer().style.height).toBe('120px'));
    expect(composer().value).toBe('First line\nSecond line\nThird line');
  });
  it('preserves the draft until accepted and does not submit on plain Enter', async () => {
    let accept!: () => void;
    vi.mocked(sendInput).mockReturnValue(
      new Promise((resolve) => {
        accept = resolve;
      }),
    );
    mount();
    type('First line\nSecond line');
    composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(sendInput).not.toHaveBeenCalled();
    click('Send');
    expect(composer().value).toBe('First line\nSecond line');
    expect(composer().disabled).toBe(true);
    expect(sendInput).toHaveBeenCalledWith('a1', '\x1b[200~First line\nSecond line\x1b[201~', {
      submit: true,
    });
    accept();
    await vi.waitFor(() => expect(composer().value).toBe(''));
    expect(localStorage.getItem('parallel-mobile:reply:a1')).toBeNull();
    expect(host.textContent).toContain('Accepted by terminal');
    // The confirmation lives on the Send button rather than a line that grows the composer.
    const labels = () => [...host.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels()).toContain('Sent');
    type('Next');
    expect(labels()).toContain('Send');
    expect(host.textContent).not.toContain('Accepted by terminal');
  });
  it('sends a shell command as one request the server can keep ordered', async () => {
    vi.mocked(sendInput).mockResolvedValue(undefined);
    mount();
    type('!');
    type('ls -la');
    click('Send');
    await vi.waitFor(() => expect(composer().value).toBe(''));
    expect(vi.mocked(sendInput).mock.calls).toEqual([
      ['a1', '\x1b[200~ls -la\x1b[201~', { submit: true, prefixKey: '!' }],
    ]);
    // The agent's shell prompt closes after the command, so the next reply is text.
    expect(composer().placeholder).toBe('Reply to agent…');
  });
  it('switches to the shell when "!" opens an empty prompt, as the desktop TUI does', () => {
    mount();
    type('!');
    expect(bashButton().getAttribute('aria-pressed')).toBe('true');
    expect(composer().value).toBe('');
    expect(composer().placeholder).toBe('Shell command…');
  });
  it('still sends a message that merely begins with "!" as text', async () => {
    vi.mocked(sendInput).mockResolvedValue(undefined);
    localStorage.setItem('parallel-mobile:reply:a1', '!important: do not deploy');
    mount();
    expect(composer().placeholder).toBe('Reply to agent…');
    click('Send');
    await vi.waitFor(() => expect(composer().value).toBe(''));
    expect(vi.mocked(sendInput).mock.calls).toEqual([
      ['a1', '\x1b[200~!important: do not deploy\x1b[201~', { submit: true }],
    ]);
  });
  it('keeps shell mode with the draft when a send fails or the task is reopened', async () => {
    vi.mocked(sendInput).mockRejectedValue(new Error('Delivery could not be confirmed'));
    mount();
    type('!');
    type('npm test');
    click('Send');
    await vi.waitFor(() => expect(host.textContent).toContain('Delivery could not be confirmed'));
    expect(bashButton().getAttribute('aria-pressed')).toBe('true');
    dispose();
    mount();
    expect(composer().value).toBe('npm test');
    expect(bashButton().getAttribute('aria-pressed')).toBe('true');
  });
  it('keeps a failed draft and restores it when reopening the task', async () => {
    vi.mocked(sendInput).mockRejectedValue(new Error('Delivery could not be confirmed'));
    mount();
    type('Do not lose this');
    click('Send');
    await vi.waitFor(() => expect(host.textContent).toContain('Delivery could not be confirmed'));
    expect(composer().value).toBe('Do not lose this');
    dispose();
    mount();
    expect(composer().value).toBe('Do not lose this');
  });
  it('retains an empty notes draft instead of reloading the deleted text', async () => {
    mount();
    click('Notes');
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLTextAreaElement>('#task-notes')?.value).toBe(
        'Notes from desktop',
      ),
    );
    const notes = host.querySelector<HTMLTextAreaElement>('#task-notes');
    if (!notes) throw new Error('Missing notes');
    notes.value = '';
    notes.dispatchEvent(new Event('input', { bubbles: true }));
    dispose();
    mount();
    click('Notes');
    expect(host.querySelector<HTMLTextAreaElement>('#task-notes')?.value).toBe('');
    expect(host.textContent).toContain('Draft saved on this phone');
  });
});

describe('phone next task navigation', () => {
  it.each(['needs_input', 'error'] as const)(
    'floats navigation to a task with %s above the terminal keys',
    (attention) => {
      const first = agents()[0];
      vi.mocked(agents).mockReturnValue([
        first,
        { ...first, agentId: 'a2', taskId: 't2', attention: 'active' },
        { ...first, agentId: 'a3', taskId: 't3', taskName: 'Needs attention', attention },
      ]);
      mount();
      expect(
        host.querySelector('.mobile-output-actions .mobile-next-task')?.getAttribute('aria-label'),
      ).toBe('Next task needing you: Needs attention');
      expect(host.querySelector('.mobile-task-header .mobile-next-task')).toBeNull();
      expect(host.querySelector('.mobile-keys .mobile-next-task')).toBeNull();
      click('Next task →');
      expect(onNextTask).toHaveBeenCalledWith('t3');
      expect(sendInput).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['a1', 't2'],
    ['a2', 't3'],
    ['a3', 't1'],
  ])('cycles from %s to %s when no other task needs attention', (agentId, nextTaskId) => {
    const first = agents()[0];
    vi.mocked(agents).mockReturnValue(
      ['a1', 'a2', 'a3'].map((id, index) => ({
        ...first,
        agentId: id,
        taskId: `t${index + 1}`,
        attention: id === agentId ? 'needs_input' : 'active',
      })),
    );
    mount(agentId);
    expect(host.querySelector('.mobile-task-header .mobile-next-task')?.textContent).toBe('→');
    expect(host.querySelector('.mobile-output-actions .mobile-next-task')).toBeNull();
    click('→');
    expect(onNextTask).toHaveBeenCalledWith(nextTaskId);
  });

  it('updates navigation as attention changes and hides it when no other task exists', () => {
    const first = agents()[0];
    const second: RemoteAgent = {
      ...first,
      agentId: 'a2',
      taskId: 't2',
      taskName: 'Second task',
      attention: 'active',
    };
    const [list, setList] = createSignal([first]);
    // eslint-disable-next-line solid/reactivity -- the component tracks reads through this mock
    vi.mocked(agents).mockImplementation(list);
    mount();
    expect(host.querySelector('.mobile-next-task')).toBeNull();
    setList([first, second]);
    expect(
      host.querySelector('.mobile-task-header .mobile-next-task')?.getAttribute('aria-label'),
    ).toBe('Next task: Second task');
    setList([first, { ...second, attention: 'needs_input' }]);
    expect(host.querySelector('.mobile-task-header .mobile-next-task')).toBeNull();
    expect(
      host.querySelector('.mobile-output-actions .mobile-next-task')?.getAttribute('aria-label'),
    ).toBe('Next task needing you: Second task');
    click('Next task →');
    expect(onNextTask).toHaveBeenLastCalledWith('t2');
    setList([first, second]);
    expect(host.querySelector('.mobile-output-actions .mobile-next-task')).toBeNull();
    click('→');
    expect(onNextTask).toHaveBeenLastCalledWith('t2');
    setList([first]);
    expect(host.querySelector('.mobile-next-task')).toBeNull();
  });
});

describe('phone terminal viewport', () => {
  function viewport(height = 1200) {
    const scroller = host.querySelector<HTMLDivElement>('.mobile-terminal-scroll');
    const content = host.querySelector<HTMLDivElement>('.mobile-terminal');
    if (!scroller || !content) throw new Error('Missing terminal viewport');
    let top = 0;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: height },
      clientHeight: { configurable: true, value: 300 },
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = Math.max(0, Math.min(height - 300, value));
        },
      },
    });
    return { scroller, content };
  }
  function xtermScreen() {
    const element = document.createElement('div');
    const screen = document.createElement('div');
    screen.className = 'xterm-screen';
    element.append(screen);
    terminalMocks.element = element;
    return screen;
  }
  /** The drawn rows' vertical shift in pixels; negative moves them up. */
  function shift(screen: HTMLElement) {
    const match = /translateY\((-?[\d.e-]+)px\)/.exec(screen.style.transform);
    return match ? Number(match[1]) : 0;
  }
  function touch(target: HTMLElement, type: string, x: number, y: number, count = 1) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', {
      value: Array.from({ length: count }, (_, identifier) => ({
        clientX: x,
        clientY: y,
        identifier,
      })),
    });
    target.dispatchEvent(event);
    return event;
  }

  it('fits the desktop columns to the phone and repaints on open and return from Notes', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(360);
    mount();
    const { content } = viewport();
    terminalMocks.scrollback?.('', 120, 40);
    await vi.waitFor(() => expect(terminalMocks.refresh).toHaveBeenCalledWith(0, 39));
    const fittedFontSize = terminalMocks.options.fontSize;
    expect(fittedFontSize).toBeGreaterThan(0);
    expect(fittedFontSize).toBeLessThan(14);
    expect(content.style.zoom).toBe('');
    expect(parseFloat(content.style.width)).toBeLessThanOrEqual(360);
    click('A+');
    await vi.waitFor(() =>
      expect(terminalMocks.options.fontSize).toBeCloseTo(fittedFontSize * 1.25),
    );
    click('Notes');
    terminalMocks.refresh.mockClear();
    click('Terminal');
    await vi.waitFor(() => expect(terminalMocks.refresh).toHaveBeenCalledWith(0, 39));
  });

  it('takes the PTY size when the desktop resizes, so later lines wrap like the desktop', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(360);
    mount();
    terminalMocks.scrollback?.('', 120, 40);
    await vi.waitFor(() => expect(terminalMocks.refresh).toHaveBeenCalledWith(0, 39));
    const wideFontSize = terminalMocks.options.fontSize;
    terminalMocks.refresh.mockClear();
    terminalMocks.terminalSize?.(60, 30);
    await vi.waitFor(() => expect(terminalMocks.refresh).toHaveBeenCalledWith(0, 29));
    // Half the columns fit the same width at a larger font.
    expect(terminalMocks.options.fontSize).toBeGreaterThan(wideFontSize);
  });

  it('fits a tall grid to the pane height so vertical swipes go straight to history', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(360);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    // Real xterm rows are taller than fontSize * lineHeight and snap to whole pixels.
    const element = document.createElement('div');
    const screen = document.createElement('div');
    screen.className = 'xterm-screen';
    element.append(screen);
    Object.defineProperties(screen, {
      offsetWidth: { get: () => Math.ceil(120 * terminalMocks.options.fontSize * 0.6) },
      offsetHeight: { get: () => 40 * Math.ceil(terminalMocks.options.fontSize * 1.4) },
    });
    terminalMocks.element = element;
    mount();
    const { content } = viewport();
    terminalMocks.scrollback?.('', 120, 40);
    await vi.waitFor(() => expect(terminalMocks.refresh).toHaveBeenCalledWith(0, 39));
    expect(parseFloat(content.style.height)).toBeLessThanOrEqual(600);
    // Still fills the pane: within one pixel per row of the limit.
    expect(parseFloat(content.style.height)).toBeGreaterThan(600 - 40);
  });

  it('keeps a wide grid readable and overflowing so a full-screen agent UI can be panned', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(360);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    mount();
    const { content } = viewport();
    terminalMocks.scrollback?.('', 120, 40);
    await vi.waitFor(() => expect(terminalMocks.refresh).toHaveBeenCalledWith(0, 39));
    // Fitting to the width alone would land near 4px per row and fit the pane exactly.
    expect(terminalMocks.options.fontSize).toBeGreaterThan(10);
    expect(parseFloat(content.style.width)).toBeGreaterThan(360);
  });

  it('shows terminal output as selectable text until Select is turned off', () => {
    terminalMocks.lines = ['$ npm test', 'All 12 tests passed'];
    mount();
    const select = host.querySelector<HTMLButtonElement>('[aria-label="Select terminal text"]');
    if (!select) throw new Error('Missing Select button');
    expect(select.getAttribute('aria-pressed')).toBe('false');
    select.click();
    expect(select.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('.mobile-terminal-text')?.textContent).toBe(
      '$ npm test\nAll 12 tests passed',
    );
    expect(host.querySelector('.mobile-terminal-scroll')?.classList).toContain(
      'mobile-terminal-hidden',
    );
    select.click();
    expect(host.querySelector('.mobile-terminal-text')).toBeNull();
    expect(host.querySelector('.mobile-terminal-hidden')).toBeNull();
  });

  it('opens Terminal with immediately usable keys even with the old Read preference', async () => {
    localStorage.setItem('parallel-mobile:output-view', 'output');
    vi.mocked(sendInput).mockResolvedValue(undefined);
    mount();
    expect(host.querySelector('.mobile-terminal-hidden')).toBeNull();
    expect(host.querySelector('[aria-expanded]')).toBeNull();
    expect([...host.querySelectorAll('nav button')].map((button) => button.textContent)).toEqual([
      'Terminal',
      'Notes',
      'Diff',
    ]);
    expect(host.querySelector('.mobile-tabs [aria-label="Smaller terminal text"]')).not.toBeNull();
    expect(host.querySelector('.mobile-tabs [aria-label="Larger terminal text"]')).not.toBeNull();
    expect(
      [...host.querySelectorAll('.mobile-keys button')].map((button) => button.textContent),
    ).toEqual(['Enter', '/', 'Tab', '↑', '↓', 'Esc', 'Ctrl+C']);
    click('Enter');
    expect(sendInput).toHaveBeenCalledWith('a1', '\r');
    await vi.waitFor(() => expect(composer().disabled).toBe(false));
    click('/');
    expect(sendInput).toHaveBeenCalledWith('a1', '/');
    await vi.waitFor(() => expect(composer().disabled).toBe(false));
    click('Notes');
    expect(host.querySelector('[aria-label="Smaller terminal text"]')).toBeNull();
  });

  it('renders the task diff in the Diff tab and hides the terminal composer', async () => {
    vi.mocked(fetchTaskDiff).mockResolvedValue({
      diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n',
      truncated: false,
    });
    mount();
    await openTab('Diff');
    await vi.waitFor(() =>
      expect(host.querySelector('.mobile-diff-path')?.textContent).toBe('src/a.ts'),
    );
    // Files start collapsed so a long change list stays scannable on a phone.
    expect(host.querySelector('.mobile-diff-line-add')).toBeNull();
    host.querySelector<HTMLButtonElement>('.mobile-diff-file-head')?.click();
    await vi.waitFor(() => expect(host.querySelector('.mobile-diff-line-add')).not.toBeNull());
    expect(host.querySelector('.mobile-diff-line-add')?.textContent).toBe('new');
    expect(host.querySelector('.mobile-diff-line-remove')?.textContent).toBe('old');
    // The prompt box types into the terminal, so it must not appear on Diff.
    expect(host.querySelector('[aria-label="Message agent"]')).toBeNull();
    // Nor may the Notes save footer leak onto a read-only tab.
    expect(host.querySelector('.mobile-notes-footer')).toBeNull();
  });

  it('still offers the notes footer on Notes, so the views stay independent', async () => {
    mount();
    await openTab('Notes');
    expect(host.querySelector('.mobile-notes-footer')).not.toBeNull();
    expect(host.querySelector('[aria-label="Message agent"]')).toBeNull();
  });

  it('says so when the desktop truncated a diff too large for the phone', async () => {
    vi.mocked(fetchTaskDiff).mockResolvedValue({
      diff: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b\n',
      truncated: true,
    });
    mount();
    await openTab('Diff');
    await vi.waitFor(() => expect(host.textContent).toContain('too large for the phone'));
  });

  it('reports no changes when the task has nothing to compare', async () => {
    vi.mocked(fetchTaskDiff).mockResolvedValue({ diff: '', truncated: false });
    mount();
    await openTab('Diff');
    await vi.waitFor(() => expect(host.textContent).toContain('No changes yet.'));
  });

  it('explains a task with no branch instead of claiming there are no changes', async () => {
    // Without the flag an empty diff reads as "nothing to review", which is wrong
    // for a task that works directly in the project folder.
    vi.mocked(fetchTaskDiff).mockResolvedValue({ diff: '', truncated: false, unsupported: true });
    mount();
    await openTab('Diff');
    await vi.waitFor(() => expect(host.textContent).toContain('no branch to compare'));
    expect(host.textContent).not.toContain('No changes yet.');
  });

  it('surfaces a diff load failure', async () => {
    vi.mocked(fetchTaskDiff).mockRejectedValue(new Error('git unavailable'));
    mount();
    await openTab('Diff');
    await vi.waitFor(() => expect(host.textContent).toContain('git unavailable'));
  });

  it('refetches the diff when re-entering the tab so new work shows up', async () => {
    vi.mocked(fetchTaskDiff).mockResolvedValue({ diff: '', truncated: false });
    mount();
    await openTab('Diff');
    await openTab('Terminal');
    await openTab('Diff');
    await vi.waitFor(() => expect(fetchTaskDiff).toHaveBeenCalledTimes(2));
  });

  it('shows the desktop readiness checks read-only in the merge dialog', async () => {
    vi.mocked(fetchMergeReadiness).mockResolvedValue({
      readiness: {
        overall: 'attention',
        checks: [
          { label: 'Merge safety', status: 'warning', detail: 'main is 2 commits ahead.' },
          { label: 'Verification', status: 'warning', detail: 'No verification was reported.' },
        ],
      },
      canMerge: true,
      baseBranch: 'main',
      branchName: 'task/thing',
    });
    mount();
    await openTab('Diff');
    await openMergeDialog();
    await vi.waitFor(() => expect(host.textContent).toContain('Needs attention'));
    expect(host.textContent).toContain('main is 2 commits ahead.');
    expect(host.textContent).toContain('No verification was reported.');
    // A warning is advisory: the merge action stays available.
    expect(dialogButton('Merge').disabled).toBe(false);
  });

  it('disables merging when readiness reports a blocker', async () => {
    vi.mocked(fetchMergeReadiness).mockResolvedValue({
      readiness: {
        overall: 'blocked',
        checks: [
          { label: 'Merge safety', status: 'blocked', detail: 'Worktree has a detached HEAD.' },
        ],
      },
      canMerge: false,
      baseBranch: 'main',
      branchName: 'task/thing',
    });
    mount();
    await openTab('Diff');
    await openMergeDialog();
    await vi.waitFor(() => expect(host.textContent).toContain('Not ready to merge'));
    expect(dialogButton('Merge').disabled).toBe(true);
  });

  it('merges with the chosen options and returns to the list', async () => {
    const back = vi.fn();
    mount('a1', back);
    await openTab('Diff');
    await openMergeDialog();
    // First tap opens the confirm step; the option checkboxes live there.
    dialogButton('Merge').click();
    await vi.waitFor(() =>
      expect(host.querySelectorAll('.mobile-dialog-option input').length).toBe(2),
    );
    for (const box of host.querySelectorAll<HTMLInputElement>('.mobile-dialog-option input')) {
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    }
    dialogButton('Merge').click();
    await vi.waitFor(() =>
      expect(mergeTask).toHaveBeenCalledWith('t1', { squash: true, cleanup: true }),
    );
    // A merged task may be gone, so the list is where the user should land.
    await vi.waitFor(() => expect(back).toHaveBeenCalled());
  });

  it('surfaces a merge failure and stays in the dialog', async () => {
    vi.mocked(mergeTask).mockRejectedValueOnce(new Error('Only worktree tasks can be merged'));
    mount();
    await openTab('Diff');
    await openMergeDialog();
    dialogButton('Merge').click();
    dialogButton('Merge').click();
    await vi.waitFor(() => expect(host.textContent).toContain('Only worktree tasks can be merged'));
    expect(host.querySelector('.mobile-dialog')).not.toBeNull();
  });

  it('closes a task after an explicit confirmation', async () => {
    mount();
    await openTab('Diff');
    await openMergeDialog();
    dialogButton('Close').click();
    await vi.waitFor(() => expect(host.textContent).toContain('Close task'));
    // The first Close only opens the confirmation; nothing is destroyed yet.
    expect(closeTask).not.toHaveBeenCalled();
    dialogButton('Close task').click();
    await vi.waitFor(() => expect(closeTask).toHaveBeenCalledWith('t1', false));
  });

  it('keeps the dialog open and lists what a close would lose', async () => {
    vi.mocked(closeTask).mockResolvedValue({
      warnings: ['2 child tasks still running', '3 unmerged commits'],
    });
    mount();
    await openTab('Diff');
    await openMergeDialog();
    dialogButton('Close').click();
    await vi.waitFor(() => expect(host.textContent).toContain('Close task'));
    dialogButton('Close task').click();
    // The desktop refused; each reason is listed above the force option.
    await vi.waitFor(() =>
      expect([...host.querySelectorAll('.mobile-dialog li')].map((li) => li.textContent)).toEqual([
        '2 child tasks still running',
        '3 unmerged commits',
      ]),
    );
    expect(host.querySelector('.mobile-dialog')).not.toBeNull();
  });

  it.each([
    [true, 'deletes its worktree and branch'],
    [false, 'The branch is kept'],
  ])('words the close from the project branch setting (%s)', async (deleteBranch, copy) => {
    vi.mocked(fetchMergeReadiness).mockResolvedValue({
      ...READY_MERGE,
      deleteBranchOnClose: deleteBranch,
    });
    mount();
    await openTab('Diff');
    await openMergeDialog();
    dialogButton('Close').click();
    await vi.waitFor(() => expect(host.textContent).toContain(copy));
    expect(host.textContent).not.toContain('stays on the branch');
  });

  it('retries a refused close with force only once the user asks', async () => {
    vi.mocked(closeTask)
      .mockResolvedValueOnce({ warnings: ['uncommitted changes'] })
      .mockResolvedValueOnce({ warnings: [] });
    mount();
    await openTab('Diff');
    await openMergeDialog();
    dialogButton('Close').click();
    await vi.waitFor(() => expect(host.textContent).toContain('Close task'));
    dialogButton('Close task').click();
    await vi.waitFor(() => expect(host.textContent).toContain('uncommitted changes'));
    // The force checkbox only appears after a refusal, and stays opt-in.
    const forceBox = host.querySelector<HTMLInputElement>('.mobile-dialog-option input');
    if (!forceBox) throw new Error('Missing force checkbox');
    expect(closeTask).toHaveBeenLastCalledWith('t1', false);
    forceBox.checked = true;
    forceBox.dispatchEvent(new Event('change', { bubbles: true }));
    dialogButton('Close task').click();
    await vi.waitFor(() => expect(closeTask).toHaveBeenLastCalledWith('t1', true));
  });

  it('hides merge and close for a view-only device', async () => {
    wsMocks.canControl = false;
    mount();
    await openTab('Diff');
    await openMergeDialog();
    await vi.waitFor(() => expect(host.textContent).toContain('Pair this phone'));
    const labels = [...host.querySelectorAll('.mobile-dialog-actions button')].map(
      (b) => b.textContent,
    );
    expect(labels).not.toContain('Merge');
    expect(labels).not.toContain('Close');
  });

  it('scrolls the desktop grid before history and shields gestures from xterm', () => {
    localStorage.setItem('parallel-mobile:output-view', 'terminal');
    mount();
    const { scroller, content } = viewport();
    const xtermGesture = vi.fn();
    document.addEventListener('touchmove', xtermGesture);
    try {
      touch(content, 'touchstart', 100, 100);
      const move = touch(content, 'touchmove', 90, 50);
      expect(scroller.scrollTop).toBe(50);
      expect(terminalMocks.scrollLines).not.toHaveBeenCalled();
      expect(move.defaultPrevented).toBe(true);
      expect(xtermGesture).not.toHaveBeenCalled();
      touch(content, 'touchend', 0, 0, 0);
      scroller.scrollTop = 900;
      terminalMocks.viewportY = 50;
      touch(content, 'touchstart', 100, 100);
      touch(content, 'touchmove', 90, 50);
      // 50px of 16.8px rows: the third row is sliding in at the bottom.
      expect(terminalMocks.scrollLines).toHaveBeenCalledWith(3);
      expect(touch(content, 'touchmove', 50, 0, 2).defaultPrevented).toBe(false);
    } finally {
      document.removeEventListener('touchmove', xtermGesture);
    }
  });

  it('carries a swipe that reaches the grid edge on into history, as one scroller', () => {
    mount();
    const { scroller } = viewport();
    const screen = xtermScreen();
    scroller.scrollTop = 40;
    touch(scroller, 'touchstart', 100, 100);
    touch(scroller, 'touchmove', 100, 300);
    expect(scroller.scrollTop).toBe(0);
    // The 160px the grid had no room for: 9 rows and 8.8px of the tenth, drawn from its top.
    expect(terminalMocks.scrollLines).toHaveBeenCalledWith(-10);
    expect(shift(screen)).toBeCloseTo(-8);
  });

  it('moves history with the finger by the pixel, not a row at a time', () => {
    mount();
    const { scroller } = viewport(300);
    const screen = xtermScreen();
    touch(scroller, 'touchstart', 100, 100);
    // 10px down reveals 10px of the row above; xterm draws from that row.
    touch(scroller, 'touchmove', 100, 110);
    expect(terminalMocks.scrollLines).toHaveBeenCalledWith(-1);
    expect(shift(screen)).toBeCloseTo(-6.8);
    touch(scroller, 'touchmove', 100, 115);
    expect(terminalMocks.scrollLines).toHaveBeenCalledTimes(1);
    expect(shift(screen)).toBeCloseTo(-1.8);
    // Turning back draws from the row below, so the rows coming in at the bottom slide in whole.
    touch(scroller, 'touchmove', 100, 105);
    expect(terminalMocks.scrollLines).toHaveBeenLastCalledWith(1);
    expect(shift(screen)).toBeCloseTo(5);
    touch(scroller, 'touchmove', 100, 100);
    expect(shift(screen)).toBe(0);
  });

  it('shifts the rows only once xterm has drawn the rows a swipe moved to', () => {
    mount();
    const { scroller } = viewport(300);
    const screen = xtermScreen();
    terminalMocks.holdRender = true;
    touch(scroller, 'touchstart', 100, 100);
    touch(scroller, 'touchmove', 100, 110);
    expect(terminalMocks.scrollLines).toHaveBeenCalledWith(-1);
    // The old rows are still on screen: shifting them now would show them a row off.
    expect(shift(screen)).toBe(0);
    touch(scroller, 'touchmove', 100, 112);
    expect(shift(screen)).toBe(0);
    terminalMocks.rendered?.();
    expect(shift(screen)).toBeCloseTo(-4.8);
    // Within the drawn row, the shift follows at once.
    touch(scroller, 'touchmove', 100, 114);
    expect(shift(screen)).toBeCloseTo(-2.8);
  });

  it('shows the latest row whole once output arrives after a swipe stopped just short of it', () => {
    mount();
    const { scroller } = viewport(300);
    const screen = xtermScreen();
    terminalMocks.viewportY = 98;
    touch(scroller, 'touchstart', 100, 100);
    touch(scroller, 'touchmove', 100, 70);
    touch(scroller, 'touchend', 0, 0, 0);
    expect(terminalMocks.viewportY).toBe(100);
    expect(shift(screen)).toBeCloseTo(3.6);
    // The agent prints a line; xterm follows it down a row.
    terminalMocks.baseY = 101;
    terminalMocks.viewportY = 101;
    terminalMocks.scrolled?.();
    terminalMocks.rendered?.();
    expect(shift(screen)).toBe(0);
  });

  it('keeps the drawn rows in place while the grid takes the whole move', () => {
    mount();
    const { scroller } = viewport();
    const screen = xtermScreen();
    scroller.scrollTop = 900;
    terminalMocks.viewportY = 50;
    touch(scroller, 'touchstart', 100, 100);
    touch(scroller, 'touchmove', 100, 90);
    expect(shift(screen)).toBeCloseTo(6.8);
    // Back down: the grid has room above, so history gets nothing to move.
    touch(scroller, 'touchmove', 100, 95);
    expect(scroller.scrollTop).toBe(895);
    expect(shift(screen)).toBeCloseTo(6.8);
  });

  it('drops a part-row shift when the view jumps or the screen is replaced', async () => {
    vi.mocked(sendInput).mockResolvedValue(undefined);
    localStorage.setItem('parallel-mobile:output-view', 'terminal');
    mount();
    const { scroller } = viewport(300);
    const screen = xtermScreen();
    // Let the open-at-latest fit settle, so only the jumps under test clear the shift.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const scrollMidRow = () => {
      touch(scroller, 'touchstart', 100, 100);
      touch(scroller, 'touchmove', 100, 110);
      touch(scroller, 'touchend', 0, 0, 0);
      expect(shift(screen)).not.toBe(0);
    };
    scrollMidRow();
    // A full-screen agent draws its own screen, which must not inherit the shift.
    terminalMocks.bufferChange?.();
    expect(shift(screen)).toBe(0);
    scrollMidRow();
    terminalMocks.scrollback?.('', 80, 24);
    expect(shift(screen)).toBe(0);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    scrollMidRow();
    // The desktop resized: rows refit to a new height, so the old shift no longer fits them.
    terminalMocks.terminalSize?.(100, 30);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(shift(screen)).toBe(0);
    scrollMidRow();
    type('Looks good');
    click('Send');
    await vi.waitFor(() => expect(terminalMocks.scrollToBottom).toHaveBeenCalled());
    expect(shift(screen)).toBe(0);
  });

  it('coasts a flick from the grid edge on into history', () => {
    vi.useFakeTimers();
    try {
      mount();
      const { scroller } = viewport();
      // Let the open-at-latest fit settle before placing the grid near its top.
      vi.advanceTimersByTime(16);
      scroller.scrollTop = 85;
      touch(scroller, 'touchstart', 100, 100);
      vi.advanceTimersByTime(16);
      touch(scroller, 'touchmove', 100, 140);
      vi.advanceTimersByTime(16);
      touch(scroller, 'touchmove', 100, 180);
      touch(scroller, 'touchend', 0, 0, 0);
      vi.advanceTimersByTime(1000);
      expect(scroller.scrollTop).toBe(0);
      expect(terminalMocks.scrollLines).toHaveBeenCalled();
      expect(terminalMocks.scrollLines.mock.calls.every(([lines]) => lines < 0)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps each swipe on one axis so scrolling history never pans sideways', () => {
    mount();
    const { scroller } = viewport(300);
    touch(scroller, 'touchstart', 100, 100);
    touch(scroller, 'touchmove', 90, 160);
    touch(scroller, 'touchmove', 60, 170);
    expect(scroller.scrollLeft).toBe(0);
    expect(terminalMocks.scrollLines).toHaveBeenCalled();
    terminalMocks.scrollLines.mockClear();
    touch(scroller, 'touchend', 0, 0, 0);
    touch(scroller, 'touchstart', 100, 100);
    touch(scroller, 'touchmove', 40, 90);
    touch(scroller, 'touchmove', 20, 140);
    expect(scroller.scrollLeft).toBe(80);
    expect(terminalMocks.scrollLines).not.toHaveBeenCalled();
  });

  it('waits for a clear direction before locking a swipe to an axis', () => {
    mount();
    const { scroller } = viewport(300);
    touch(scroller, 'touchstart', 100, 100);
    // Touch-down jitter leans sideways; the swipe itself is vertical.
    touch(scroller, 'touchmove', 97, 101);
    touch(scroller, 'touchmove', 95, 160);
    expect(scroller.scrollLeft).toBe(0);
    expect(terminalMocks.scrollLines).toHaveBeenCalled();
  });

  it('coasts after a flick, like native scrolling, until the next touch', () => {
    vi.useFakeTimers();
    try {
      mount();
      const { scroller } = viewport(300);
      // Let the open-at-latest fit settle before scrolling the reader back.
      vi.advanceTimersByTime(16);
      terminalMocks.viewportY = 50;
      touch(scroller, 'touchstart', 100, 300);
      vi.advanceTimersByTime(16);
      touch(scroller, 'touchmove', 100, 240);
      vi.advanceTimersByTime(16);
      touch(scroller, 'touchmove', 100, 180);
      touch(scroller, 'touchend', 0, 0, 0);
      terminalMocks.scrollLines.mockClear();
      vi.advanceTimersByTime(100);
      // The finger moved up, so history keeps moving toward the latest lines.
      expect(terminalMocks.scrollLines).toHaveBeenCalled();
      expect(terminalMocks.scrollLines.mock.calls.every(([lines]) => lines > 0)).toBe(true);
      touch(scroller, 'touchstart', 100, 100);
      terminalMocks.scrollLines.mockClear();
      vi.advanceTimersByTime(500);
      expect(terminalMocks.scrollLines).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops where the finger rested before lifting', () => {
    vi.useFakeTimers();
    try {
      mount();
      const { scroller } = viewport(300);
      touch(scroller, 'touchstart', 100, 300);
      vi.advanceTimersByTime(16);
      touch(scroller, 'touchmove', 100, 180);
      vi.advanceTimersByTime(300);
      touch(scroller, 'touchend', 0, 0, 0);
      terminalMocks.scrollLines.mockClear();
      vi.advanceTimersByTime(500);
      expect(terminalMocks.scrollLines).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('scrolls history from the empty pane below a fitted terminal without typing into the agent', () => {
    mount();
    const { scroller } = viewport(300);
    touch(scroller, 'touchstart', 100, 200);
    const move = touch(scroller, 'touchmove', 100, 260);
    // 60px is 3 rows and part of the fourth, which xterm now draws.
    expect(terminalMocks.scrollLines).toHaveBeenCalledWith(-4);
    expect(move.defaultPrevented).toBe(true);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('scrolls a full-screen agent UI by turning the wheel over the cell under the finger', () => {
    const element = document.createElement('div');
    const screen = document.createElement('div');
    screen.className = 'xterm-screen';
    element.append(screen);
    // 80x24 cells of 10px, starting 100px down the page.
    vi.spyOn(screen, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 100, width: 800, height: 240 }),
    );
    terminalMocks.element = element;
    terminalMocks.bufferType = 'alternate';
    mount();
    const { scroller } = viewport(300);
    touch(scroller, 'touchstart', 100, 200);
    // Under three rows of swipe is less than one wheel notch.
    touch(scroller, 'touchmove', 100, 240);
    expect(scrollAgent).not.toHaveBeenCalled();
    touch(scroller, 'touchmove', 100, 260);
    expect(scrollAgent).toHaveBeenCalledWith('a1', -1, 11, 17);
    // Past the grid, the nearest edge cell still gets the wheel.
    touch(scroller, 'touchmove', 900, 1100);
    expect(scrollAgent).toHaveBeenLastCalledWith('a1', expect.any(Number), 80, 24);
    expect(terminalMocks.scrollLines).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('handles wheel scrolling before xterm consumes it, while preserving browser zoom', () => {
    mount();
    const { content } = viewport(300);
    const xtermWheel = vi.fn();
    content.addEventListener('wheel', xtermWheel);
    const wheel = new WheelEvent('wheel', {
      deltaY: -3,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      bubbles: true,
      cancelable: true,
    });
    content.dispatchEvent(wheel);
    expect(terminalMocks.scrollLines).toHaveBeenCalledWith(-3);
    expect(xtermWheel).not.toHaveBeenCalled();
    expect(wheel.defaultPrevented).toBe(true);
    terminalMocks.scrollLines.mockClear();
    const zoom = new WheelEvent('wheel', {
      deltaY: -100,
      bubbles: true,
      cancelable: true,
    });
    // happy-dom's WheelEvent omits MouseEvent modifier keys.
    Object.defineProperty(zoom, 'ctrlKey', { value: true });
    content.dispatchEvent(zoom);
    expect(zoom.defaultPrevented).toBe(false);
    expect(terminalMocks.scrollLines).not.toHaveBeenCalled();
    expect(xtermWheel).not.toHaveBeenCalled();
  });

  it('does not jump when a pinch returns to one finger', () => {
    mount();
    const { scroller } = viewport(300);
    touch(scroller, 'touchstart', 100, 100);
    touch(scroller, 'touchmove', 100, 300, 2);
    touch(scroller, 'touchmove', 100, 500);
    expect(terminalMocks.scrollLines).not.toHaveBeenCalled();
    touch(scroller, 'touchmove', 100, 560);
    expect(terminalMocks.scrollLines).toHaveBeenCalledWith(-4);
  });

  it('opens a task at the latest rows without yanking a scrolled reader on reconnect', async () => {
    localStorage.setItem('parallel-mobile:output-view', 'terminal');
    mount();
    const { scroller } = viewport();
    terminalMocks.scrollback?.('', 100, 60);
    await vi.waitFor(() => expect(scroller.scrollTop).toBe(900));
    scroller.scrollTop = 120;
    scroller.dispatchEvent(new Event('scroll'));
    terminalMocks.scrollback?.('', 100, 60);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(scroller.scrollTop).toBe(120);
  });

  it('brings a scrolled reader back to the latest rows once a reply is sent', async () => {
    vi.mocked(sendInput).mockResolvedValue(undefined);
    localStorage.setItem('parallel-mobile:output-view', 'terminal');
    mount();
    const { scroller } = viewport();
    scroller.scrollTop = 120;
    scroller.dispatchEvent(new Event('scroll'));
    terminalMocks.scrollToBottom.mockClear();
    type('Looks good');
    click('Send');
    await vi.waitFor(() => expect(scroller.scrollTop).toBe(900));
    expect(terminalMocks.scrollToBottom).toHaveBeenCalled();
    expect(host.textContent).not.toContain('Latest output');
  });
});

describe('failed PR checks', () => {
  beforeEach(() => {
    vi.mocked(agents).mockReturnValue([
      {
        agentId: 'a1',
        taskId: 't1',
        taskName: 'First task',
        status: 'running',
        attention: 'idle',
        ci: 'failure',
        exitCode: null,
        lastLine: '',
      },
    ]);
  });

  it('offers Fix CI to a paired phone and opens the prompt for review', async () => {
    mount();
    const fix = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Fix CI');
    if (!fix) throw new Error('Missing Fix CI button');
    fix.click();
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Fix CI prompt"]')?.value).toBe(
        'CI failed on pull request #7.',
      ),
    );
  });

  it('keeps the open prompt when CI or the agent list changes mid-edit', async () => {
    const first = agents()[0];
    const [list, setList] = createSignal([first]);
    // eslint-disable-next-line solid/reactivity -- the component tracks reads through this mock
    vi.mocked(agents).mockImplementation(list);
    mount();
    const fix = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Fix CI');
    if (!fix) throw new Error('Missing Fix CI button');
    fix.click();
    await vi.waitFor(() =>
      expect(host.querySelector('[aria-label="Fix CI prompt"]')).not.toBeNull(),
    );
    setList([{ ...first, ci: 'pending' }]);
    expect(host.querySelector('[aria-label="Fix CI prompt"]')).not.toBeNull();
    // A reconnect briefly empties the list.
    setList([]);
    expect(host.querySelector('[aria-label="Fix CI prompt"]')).not.toBeNull();
  });

  it('shows the status but no Fix CI to a view-only phone', () => {
    wsMocks.canControl = false;
    mount();
    expect(host.textContent).toContain('CI failed');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Fix CI')).toBe(
      false,
    );
  });
});
