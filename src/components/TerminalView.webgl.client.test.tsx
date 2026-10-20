import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { WEBGL_DETACH_DELAY_MS } from '../lib/terminalPaneVisibility';
import { TerminalView } from './TerminalView';

const { redrawAllTerminals } = vi.hoisted(() => ({ redrawAllTerminals: vi.fn() }));

vi.mock('../lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/platform')>()),
  isMac: true,
}));

// happy-dom has no WebGL; a stand-in addon is enough to put the pane on the
// WebGL path that keeps its context across a brief trip off screen.
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    activate(): void {}
    dispose(): void {}
    onContextLoss() {
      return { dispose() {} };
    }
  },
}));

vi.mock('../lib/terminalFitManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/terminalFitManager')>()),
  redrawAllTerminals,
}));

let dispose: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  // happy-dom has no canvas; xterm's DOM renderer only measures glyph widths.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    font: '',
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    measureText: () => ({ width: 8 }),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('OffscreenCanvas', undefined);
  vi.stubGlobal('electron', {
    ipcRenderer: {
      invoke: vi.fn((cmd: string) =>
        cmd === IPC.SpawnAgent ? new Promise(() => {}) : Promise.resolve(undefined),
      ),
      on: () => () => undefined,
    },
  });
  redrawAllTerminals.mockClear();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('repaints every terminal, not just its own, when a pane returns on macOS (issue #121)', () => {
  const [visible, setVisible] = createSignal(true);
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(
    () => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="codex"
        args={[]}
        cwd="/tmp"
        isShell
        visible={visible()}
      />
    ),
    host,
  );

  setVisible(false);
  vi.advanceTimersByTime(WEBGL_DETACH_DELAY_MS / 2);
  expect(redrawAllTerminals).not.toHaveBeenCalled();
  setVisible(true);

  // The glyph atlas is shared, so a repaint must reset every terminal's model.
  expect(redrawAllTerminals).toHaveBeenCalledTimes(1);
});
