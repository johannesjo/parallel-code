import { render } from 'solid-js/web';
import type { FileLinkMenu } from './file-link-menu';
import type { ComponentProps } from 'solid-js';
import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { TerminalView } from './TerminalView';

const { terminals } = vi.hoisted(() => ({ terminals: [] as Terminal[] }));

vi.mock('../lib/terminalFitManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/terminalFitManager')>();
  return {
    ...actual,
    registerTerminal: (...args: Parameters<typeof actual.registerTerminal>) => {
      terminals.push(args[3]);
      actual.registerTerminal(...args);
    },
  };
});

type ChannelListener = (msg: unknown) => void;

let invoke: ReturnType<typeof vi.fn>;
let channelListeners: ChannelListener[];
let resolveSpawn: () => void;
const disposers: Array<() => void> = [];

beforeEach(() => {
  // happy-dom has no canvas; xterm's DOM renderer only measures glyph widths.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    font: '',
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    measureText: () => ({ width: 8 }),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('OffscreenCanvas', undefined);
  channelListeners = [];
  invoke = vi.fn((cmd: string) => {
    if (cmd !== IPC.SpawnAgent) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      resolveSpawn = () => resolve({ canvasTools: false });
    });
  });
  vi.stubGlobal('electron', {
    ipcRenderer: {
      invoke,
      on: (_channel: string, listener: ChannelListener) => {
        channelListeners.push(listener);
        return () => undefined;
      },
    },
  });
});

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  terminals.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mountTerminal(
  onData?: (data: Uint8Array) => void,
  onTranscriptMarksReady?: ComponentProps<typeof TerminalView>['onTranscriptMarksReady'],
  extra: Partial<ComponentProps<typeof TerminalView>> = {},
): Terminal {
  const host = document.createElement('div');
  document.body.append(host);
  disposers.push(
    render(
      () => (
        <TerminalView
          taskId="task-1"
          agentId="agent-1"
          command="codex"
          args={[]}
          cwd="/tmp"
          isShell
          onData={onData}
          onTranscriptMarksReady={onTranscriptMarksReady}
          {...extra}
        />
      ),
      host,
    ),
  );
  const term = terminals.at(-1);
  if (!term) throw new Error('TerminalView did not register a terminal');
  return term;
}

function writesToAgent(): unknown[] {
  return invoke.mock.calls.filter(([cmd]) => cmd === IPC.WriteToAgent).map(([, args]) => args);
}

describe('TerminalView', () => {
  it.each([
    'https://example.com/',
    '\x1b]8;;https://example.com/\x07https://example.com/\x1b]8;;\x07',
  ])('opens a terminal URL once per modified click: %j', async (output) => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(256);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(16);
    const term = mountTerminal();
    await new Promise<void>((resolve) => term.write(`\x1b[?1000h\x1b[?1006h${output}`, resolve));
    const mouseReports: string[] = [];
    term.onData((data) => mouseReports.push(data));
    const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen) throw new Error('Missing terminal screen');
    screen.style.padding = '0px';
    const click = (modified: boolean, clientX = 4) => {
      for (const type of ['mousemove', 'mousedown', 'mouseup']) {
        screen.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX,
            clientY: 8,
            ctrlKey: modified,
            metaKey: modified,
            buttons: type === 'mousedown' ? 1 : 0,
          }),
        );
      }
    };
    click(true);
    expect(mouseReports).toEqual([]);
    expect(invoke.mock.calls.filter(([cmd]) => cmd === IPC.ShellOpenExternal)).toEqual([
      [IPC.ShellOpenExternal, { url: 'https://example.com/' }],
    ]);

    // Ordinary clicks still reach the TUI, including after a handled link click.
    click(false);
    expect(mouseReports).toEqual(['\x1b[<0;1;1M', '\x1b[<0;1;1m']);
    mouseReports.length = 0;
    click(true, 196);
    expect(mouseReports).toEqual(['\x1b[<16;25;1M', '\x1b[<16;25;1m']);
    expect(invoke.mock.calls.filter(([cmd]) => cmd === IPC.ShellOpenExternal)).toHaveLength(1);
  });

  it('releases step markers when scrollback truncates their lines', async () => {
    const onTranscriptMarksReady =
      vi.fn<NonNullable<ComponentProps<typeof TerminalView>['onTranscriptMarksReady']>>();
    const term = mountTerminal(undefined, onTranscriptMarksReady);
    const nav = onTranscriptMarksReady.mock.calls[0]?.[0];
    if (!nav) throw new Error('TerminalView did not register step navigation');
    term.options.scrollback = 0;
    const registerMarker = vi.spyOn(term, 'registerMarker');
    const scrollToLine = vi.spyOn(term, 'scrollToLine').mockImplementation(() => {});

    nav.mark('step');
    nav.mark('step');
    expect(registerMarker).toHaveBeenCalledTimes(1);
    expect(nav.jump('step')).toBe(true);
    const marker = registerMarker.mock.results[0].value;

    await new Promise<void>((resolve) => term.write('\r\n'.repeat(term.rows + 2), resolve));
    expect(marker.isDisposed).toBe(true);
    expect(nav.jump('step')).toBe(false);

    nav.mark('step');
    expect(registerMarker).toHaveBeenCalledTimes(2);
    expect(nav.jump('step')).toBe(true);
    expect(scrollToLine).toHaveBeenCalledTimes(2);
    disposers.pop()?.();
    expect(onTranscriptMarksReady).toHaveBeenLastCalledWith(undefined);
  });

  it('holds input until the agent has spawned', async () => {
    const term = mountTerminal();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(IPC.SpawnAgent, expect.anything()));

    term.input('hi');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(writesToAgent()).toEqual([]);

    resolveSpawn();
    await vi.waitFor(() =>
      expect(writesToAgent()).toEqual([expect.objectContaining({ data: 'hi' })]),
    );
  });

  it('flushes output when animation frames never arrive', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const onData = vi.fn();
    mountTerminal(onData);
    await vi.waitFor(() => expect(channelListeners.length).toBeGreaterThan(0));

    for (const listener of channelListeners)
      listener({ type: 'Data', data: new TextEncoder().encode('ready') });

    await vi.waitFor(() => expect(onData).toHaveBeenCalled());
  });
});

it('opens a file link menu on a plain click and its open action on a modified one', async () => {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(256);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(16);
  const run = vi.fn(),
    open = vi.fn();
  const fileLinkMenu = vi.fn(
    (): FileLinkMenu => ({ actions: [{ label: 'Copy path', run }], open }),
  );
  const term = mountTerminal(undefined, undefined, { fileLinkMenu });
  await new Promise<void>((resolve) => term.write('src/a.ts:7', resolve));
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
  if (!screen) throw new Error('Missing terminal screen');
  screen.style.padding = '0px';
  const click = (init: MouseEventInit = {}) => {
    for (const type of ['mousemove', 'mousedown', 'mouseup'])
      screen.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: 4,
          clientY: 8,
          buttons: type === 'mousedown' ? 1 : 0,
          ...init,
        }),
      );
  };
  const opens = () => invoke.mock.calls.filter(([cmd]) => cmd === IPC.OpenPath);

  click();
  expect(fileLinkMenu).toHaveBeenLastCalledWith('/tmp/src/a.ts', 7);
  const item = document.querySelector<HTMLButtonElement>('[role="menuitem"]');
  expect(item?.textContent).toBe('Copy path');
  item?.click();
  expect(run).toHaveBeenCalledOnce();
  expect(open).not.toHaveBeenCalled();

  click({ ctrlKey: true, metaKey: true });
  expect(open).toHaveBeenCalledOnce();
  expect(opens()).toEqual([]);

  // A file with nowhere to open on its own offers its menu on Cmd/Ctrl+click.
  fileLinkMenu.mockReturnValueOnce({ actions: [{ label: 'Copy path', run }], open: undefined });
  click({ ctrlKey: true, metaKey: true });
  expect(document.querySelector('[role="menuitem"]')?.textContent).toBe('Copy path');
  document
    .querySelector('.terminal-selection-backdrop')
    ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

  // Shift asks for the default app, bypassing the menu's own open.
  click({ ctrlKey: true, metaKey: true, shiftKey: true });
  expect(open).toHaveBeenCalledOnce();
  expect(opens()).toEqual([[IPC.OpenPath, { filePath: '/tmp/src/a.ts' }]]);
});

it('links a bare file name only once the terminal finds the file', async () => {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(256);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(16);
  const fileLinkMenu = vi.fn(
    (): FileLinkMenu => ({ actions: [{ label: 'Copy path', run: vi.fn() }] }),
  );
  const findBareFile = vi.fn((name: string) =>
    Promise.resolve(name === 'notes.md' ? '/repo/docs/notes.md' : undefined),
  );
  const term = mountTerminal(undefined, undefined, { fileLinkMenu, findBareFile });
  await new Promise<void>((resolve) => term.write('see notes.md:3\r\nsee other.md', resolve));
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
  if (!screen) throw new Error('Missing terminal screen');
  screen.style.padding = '0px';
  const click = async (clientY: number) => {
    const fire = (type: string) =>
      screen.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: 44,
          clientY,
          buttons: type === 'mousedown' ? 1 : 0,
        }),
      );
    fire('mousemove');
    // The provider answers once the lookup settles.
    await vi.waitFor(() => expect(findBareFile).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve));
    fire('mousedown');
    fire('mouseup');
  };

  await click(8);
  expect(findBareFile).toHaveBeenLastCalledWith('notes.md');
  expect(fileLinkMenu).toHaveBeenLastCalledWith('/repo/docs/notes.md', 3);
  document
    .querySelector('.terminal-selection-backdrop')
    ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

  fileLinkMenu.mockClear();
  findBareFile.mockClear();
  await click(24);
  expect(findBareFile).toHaveBeenLastCalledWith('other.md');
  expect(fileLinkMenu).not.toHaveBeenCalled();
});

it('keeps bare file names plain where the terminal cannot look them up', async () => {
  const fileLinkMenu = vi.fn((): FileLinkMenu => ({ actions: [] }));
  const term = mountTerminal(undefined, undefined, { fileLinkMenu });
  await new Promise<void>((resolve) => term.write('see notes.md', resolve));
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
  if (!screen) throw new Error('Missing terminal screen');
  screen.style.padding = '0px';
  for (const type of ['mousemove', 'mousedown', 'mouseup'])
    screen.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 44, clientY: 8 }));
  await new Promise((resolve) => setTimeout(resolve));
  expect(fileLinkMenu).not.toHaveBeenCalled();
});

it('keeps selecting text inside a file link free of its menu', async () => {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(256);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(16);
  const fileLinkMenu = vi.fn(() => ({
    actions: [{ label: 'Copy path', run: vi.fn() }],
    open: vi.fn(),
  }));
  const term = mountTerminal(undefined, undefined, { fileLinkMenu });
  await new Promise<void>((resolve) => term.write('src/a.ts:7', resolve));
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
  if (!screen) throw new Error('Missing terminal screen');
  screen.style.padding = '0px';
  const fire = (type: string, clientX: number, buttons: number) =>
    screen.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 8, buttons }),
    );
  fire('mousemove', 4, 0);
  fire('mousedown', 4, 1);
  // xterm tracks drags on the document once the button is down.
  for (const x of [20, 40])
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: 8, buttons: 1 }));
  term.select(0, 0, 5);
  fire('mouseup', 40, 0);
  expect(document.querySelector('[role="menuitem"]')).toBeNull();
});

it('selects a double-clicked file link instead of keeping its menu open', async () => {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(256);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(16);
  const fileLinkMenu = vi.fn(() => ({
    actions: [{ label: 'Copy path', run: vi.fn() }],
    open: vi.fn(),
  }));
  const term = mountTerminal(undefined, undefined, { fileLinkMenu });
  await new Promise<void>((resolve) => term.write('see src/a.ts:7 now', resolve));
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
  if (!screen) throw new Error('Missing terminal screen');
  screen.style.padding = '0px';
  for (const type of ['mousemove', 'mousedown', 'mouseup'])
    screen.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: 60,
        clientY: 8,
        buttons: type === 'mousedown' ? 1 : 0,
      }),
    );
  // The menu sits off the pointer, so the second press can't land on it.
  const menu = document.querySelector<HTMLElement>('.terminal-selection-menu');
  expect([menu?.style.left, menu?.style.top]).toEqual(['64px', '12px']);
  const backdrop = document.querySelector('.terminal-selection-backdrop');
  expect(backdrop).not.toBeNull();
  // The double-click's second press lands on the menu's backdrop, not on xterm.
  backdrop?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  expect(document.querySelector('[role="menuitem"]')).toBeNull();
  expect(term.getSelection()).toBe('src/a.ts:7');
});

it('offers a selection context menu and preserves the captured text for the named recipient', async () => {
  const onSendSelection = vi.fn();
  const term = mountTerminal(undefined, undefined, {
    onSendSelection,
    onSecondOpinion: vi.fn(),
    handoffRecipients: [{ id: 'other', label: 'Codex' }],
  });
  await new Promise<void>((resolve) => term.write('Review this finding', resolve));
  term.select(0, 0, 19);
  const trigger = document.querySelector<HTMLButtonElement>(
    '[aria-label="Actions for selected text"]',
  );
  expect(trigger).not.toBeNull();
  trigger?.click();
  term.clearSelection();
  const send = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) =>
    b.textContent?.includes('Send to Codex'),
  );
  send?.click();
  expect(onSendSelection).toHaveBeenCalledWith('Review this finding', 'other');
});

it('keeps Second opinion on right-click', () => {
  const onSecondOpinion = vi.fn();
  const term = mountTerminal(undefined, undefined, { onSecondOpinion });
  term.element?.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }),
  );
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) =>
    b.textContent?.includes('Second opinion'),
  );
  item?.click();
  expect(onSecondOpinion).toHaveBeenCalledOnce();
});

describe('OSC 52 clipboard writes', () => {
  // Claude Code's fullscreen mode captures the mouse, keeps the selection
  // itself, and copies it with OSC 52; xterm.js then has no selection to copy.
  const copySequence = (text: string) =>
    `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
  const write = (term: Terminal, data: string) =>
    new Promise<void>((resolve) => term.write(data, resolve));

  it('copies the text a program sends right after the user selects in the pane', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const term = mountTerminal();
    const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen) throw new Error('Missing terminal screen');
    screen.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    await write(term, copySequence('selected in Claude ✓'));
    expect(writeText).toHaveBeenCalledExactlyOnceWith('selected in Claude ✓');
  });

  it('copies after a long drag that started in the pane ends outside it', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const term = mountTerminal();
    const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen) throw new Error('Missing terminal screen');
    screen.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }));
    now += 10_000;
    document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    await write(term, copySequence('long drag'));
    expect(writeText).toHaveBeenCalledExactlyOnceWith('long drag');
  });

  it('ignores copies replayed or sent without user input', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const term = mountTerminal();
    // A click elsewhere in the app must not arm this pane.
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await write(term, copySequence('stale selection from scrollback'));
    expect(writeText).not.toHaveBeenCalled();
  });
});
