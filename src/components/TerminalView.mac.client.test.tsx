import { render } from 'solid-js/web';
import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

// xterm.js and the keybinding layer read the platform once, at import, so this
// file stubs macOS before importing TerminalView. Issue #326.
const { terminals } = vi.hoisted(() => {
  Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
  Object.defineProperty(navigator, 'userAgent', {
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Electron',
    configurable: true,
  });
  return { terminals: [] as Terminal[] };
});

// happy-dom has no WebGL; the real addon would draw to the stub canvas from a timer.
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    activate(): void {}
    dispose(): void {}
    onContextLoss() {
      return { dispose() {} };
    }
  },
}));

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

const { TerminalView } = await import('./TerminalView');

let invoke: ReturnType<typeof vi.fn>;
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
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(256);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(16);
  invoke = vi.fn((cmd: string) =>
    Promise.resolve(cmd === IPC.SpawnAgent ? { canvasTools: false } : undefined),
  );
  vi.stubGlobal('electron', {
    ipcRenderer: { invoke, on: () => () => undefined },
  });
});

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  terminals.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountClaudeFullscreen(): Promise<{ term: Terminal; screen: HTMLElement }> {
  const host = document.createElement('div');
  document.body.append(host);
  disposers.push(
    render(
      () => (
        <TerminalView taskId="task-1" agentId="agent-1" command="claude" args={[]} cwd="/tmp" />
      ),
      host,
    ),
  );
  const term = terminals.at(-1);
  if (!term) throw new Error('TerminalView did not register a terminal');
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(IPC.SpawnAgent, expect.anything()));
  // Claude Code's fullscreen mode turns on SGR button-event mouse tracking.
  await new Promise<void>((resolve) => term.write('\x1b[?1002h\x1b[?1006hhello world', resolve));
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
  if (!screen) throw new Error('Missing terminal screen');
  screen.style.padding = '0px';
  return { term, screen };
}

function writesToAgent(): string[] {
  return invoke.mock.calls
    .filter(([cmd]) => cmd === IPC.WriteToAgent)
    .map(([, args]) => (args as { data: string }).data);
}

function press(term: Terminal, init: KeyboardEventInit) {
  term.textarea?.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
  );
}

it('Option+drag selects text under mouse tracking, and Cmd+C copies it', async () => {
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  const { term, screen } = await mountClaudeFullscreen();
  const mouseReports: string[] = [];
  term.onData((data) => mouseReports.push(data));

  const drag = { altKey: true, detail: 1, clientY: 8, bubbles: true, cancelable: true };
  screen.dispatchEvent(new MouseEvent('mousedown', { ...drag, clientX: 2, buttons: 1 }));
  // xterm tracks drags on the document once the button is down.
  document.dispatchEvent(new MouseEvent('mousemove', { ...drag, clientX: 38, buttons: 1 }));
  document.dispatchEvent(new MouseEvent('mouseup', { ...drag, clientX: 38, buttons: 0 }));

  expect(mouseReports).toEqual([]);
  expect(term.getSelection()).toBe('hello');

  press(term, { key: 'c', keyCode: 67, metaKey: true });
  expect(writeText).toHaveBeenCalledWith('hello');
  expect(writesToAgent()).toEqual([]);
});

it('Option+click under mouse tracking sends the agent nothing', async () => {
  const { term, screen } = await mountClaudeFullscreen();
  const sent: string[] = [];
  term.onData((data) => sent.push(data));
  const click = { altKey: true, detail: 1, clientX: 30, clientY: 8, bubbles: true };
  screen.dispatchEvent(new MouseEvent('mousedown', { ...click, buttons: 1 }));
  document.dispatchEvent(new MouseEvent('mouseup', { ...click, buttons: 0 }));
  expect(term.options.altClickMovesCursor).toBe(false);
  expect(sent).toEqual([]);
});

it('Option+click still moves the cursor in a plain shell', async () => {
  const { term, screen } = await mountClaudeFullscreen();
  await new Promise<void>((resolve) => term.write('\x1b[?1002l\x1b[?1006l\x1b[1;1H', resolve));
  const sent: string[] = [];
  term.onData((data) => sent.push(data));
  const click = { altKey: true, detail: 1, clientX: 30, clientY: 8, bubbles: true };
  screen.dispatchEvent(new MouseEvent('mousedown', { ...click, buttons: 1 }));
  document.dispatchEvent(new MouseEvent('mouseup', { ...click, buttons: 0 }));
  expect(term.options.altClickMovesCursor).toBe(true);
  // xterm sent its cursor move (empty here: happy-dom has no layout to aim at).
  expect(sent).toHaveLength(1);
});

it('Edit > Copy copies an xterm selection under mouse tracking', async () => {
  const { term } = await mountClaudeFullscreen();
  term.select(0, 0, 5);
  const clipboardData = new DataTransfer();
  const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData });
  term.textarea?.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(clipboardData.getData('text/plain')).toBe('hello');
});

it('still sends Ctrl+C to the agent as an interrupt', async () => {
  const { term } = await mountClaudeFullscreen();
  press(term, { key: 'c', keyCode: 67, ctrlKey: true });
  await vi.waitFor(() => expect(writesToAgent()).toContain('\x03'));
});
