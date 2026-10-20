import { render } from 'solid-js/web';
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
  expect(document.querySelector('.terminal-second-opinion')).toBeNull();
  trigger?.click();
  term.clearSelection();
  const send = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) =>
    b.textContent?.includes('Send to Codex'),
  );
  send?.click();
  expect(onSendSelection).toHaveBeenCalledWith('Review this finding', 'other');
});

it('keeps Second opinion on right-click without an overlay button', () => {
  const onSecondOpinion = vi.fn();
  const term = mountTerminal(undefined, undefined, { onSecondOpinion });
  expect(document.querySelector('.terminal-second-opinion')).toBeNull();
  term.element?.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }),
  );
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) =>
    b.textContent?.includes('Second opinion'),
  );
  item?.click();
  expect(onSecondOpinion).toHaveBeenCalledOnce();
});
