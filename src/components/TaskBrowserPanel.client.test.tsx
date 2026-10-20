import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { appendBrowserReference, markBrowserFocused, setTaskFocusedPanel } from '../store/store';
import { TaskBrowserPanel } from './TaskBrowserPanel';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock('../store/store', () => ({
  appendBrowserReference: vi.fn(),
  markBrowserFocused: vi.fn(),
  setTaskBrowserUrl: vi.fn(),
  setActiveTask: vi.fn(),
  setTaskFocusedPanel: vi.fn(),
}));
const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
  document.body.classList.remove('dragging-task');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function mount(onClose = vi.fn()) {
  const listeners = new Map<string, (value: unknown) => void>();
  Object.assign(window, {
    electron: {
      ipcRenderer: {
        on: (channel: string, listener: (value: unknown) => void) => {
          listeners.set(channel, listener);
          return () => listeners.delete(channel);
        },
      },
    },
  });
  const container = document.createElement('div');
  document.body.append(container);
  disposers.push(
    render(() => <TaskBrowserPanel taskId="task-1" active={true} onClose={onClose} />, container),
  );
  return { container, listeners, onClose };
}

it('keeps task identity across remounts while assigning a fresh view ID', () => {
  mount();
  disposers.pop()?.();
  mount();
  const creates = vi
    .mocked(invoke)
    .mock.calls.filter(([, args]) => args?.action === 'create')
    .map(([, args]) => args);
  expect(creates).toHaveLength(2);
  expect(creates[0]?.taskId).toBe('task-1');
  expect(creates[1]?.taskId).toBe('task-1');
  expect(creates[0]?.id).not.toBe(creates[1]?.id);
});

it('opens a URL and routes only this preview’s picked reference to its task', async () => {
  const { container, listeners } = mount();
  await Promise.resolve();
  await Promise.resolve();
  const create = vi.mocked(invoke).mock.calls.find(([, args]) => args?.action === 'create')?.[1];
  const input = container.querySelector('input');
  if (!input) throw new Error('Address field missing');
  input.value = 'localhost:5173';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  container
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  expect(invoke).toHaveBeenCalledWith(IPC.BrowserCommand, {
    id: create?.id,
    action: 'navigate',
    url: 'localhost:5173',
  });
  const state = {
    id: create?.id,
    url: 'http://localhost:5173/',
    loading: false,
    picking: false,
    canGoBack: false,
    canGoForward: false,
    error: null,
    reference: 'Selected #save',
  };
  listeners.get(IPC.BrowserState)?.({ ...state, id: 'another-preview' });
  expect(appendBrowserReference).not.toHaveBeenCalled();
  listeners.get(IPC.BrowserState)?.(state);
  expect(appendBrowserReference).toHaveBeenCalledWith('task-1', 'Selected #save');
});

it('shows navigation failures and closes the native view on unmount', async () => {
  const { container } = mount();
  await Promise.resolve();
  await Promise.resolve();
  vi.mocked(invoke).mockRejectedValueOnce(new Error('Invalid address'));
  container
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await Promise.resolve();
  await Promise.resolve();
  expect(container.textContent).toContain('Invalid address');
  disposers.pop()?.();
  expect(invoke).toHaveBeenCalledWith(
    IPC.BrowserCommand,
    expect.objectContaining({ action: 'close' }),
  );
});

it('routes native focus only to its task without stealing keyboard focus', async () => {
  const { listeners } = mount();
  await Promise.resolve();
  const id = vi.mocked(invoke).mock.calls.find(([, args]) => args?.action === 'create')?.[1]?.id;
  listeners.get(IPC.BrowserState)?.({ id: 'other', focused: true });
  expect(markBrowserFocused).not.toHaveBeenCalled();
  listeners.get(IPC.BrowserState)?.({ id, focused: true });
  expect(markBrowserFocused).toHaveBeenCalledWith('task-1');
  expect(setTaskFocusedPanel).not.toHaveBeenCalled();
});

it('closes only this preview when its native guest requests it', async () => {
  const { listeners, onClose } = mount();
  await Promise.resolve();
  const id = vi.mocked(invoke).mock.calls.find(([, args]) => args?.action === 'create')?.[1]?.id;

  listeners.get(IPC.BrowserState)?.({ id: 'other', closeRequested: true });
  expect(onClose).not.toHaveBeenCalled();
  listeners.get(IPC.BrowserState)?.({ id, closeRequested: true });
  expect(onClose).toHaveBeenCalledOnce();
});

it('hides the native view throughout task, terminal, and sidebar drags', async () => {
  let tick: FrameRequestCallback = () => undefined;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    tick = callback;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const { container, listeners } = mount();
  await Promise.resolve();
  await Promise.resolve();
  const viewport = container.querySelector('.task-browser-viewport');
  if (!viewport) throw new Error('Missing viewport');
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 10, 200, 200));
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(viewport);
  const id = vi.mocked(invoke).mock.calls.find(([, args]) => args?.action === 'create')?.[1]?.id;
  listeners.get(IPC.BrowserState)?.({ id, url: 'http://localhost:3000/' });
  const bounds = { x: 10, y: 10, width: 200, height: 200 };
  expect(invoke).toHaveBeenLastCalledWith(IPC.BrowserBounds, { id, bounds });
  document.body.classList.add('dragging-task');
  tick(0);
  expect(invoke).toHaveBeenLastCalledWith(IPC.BrowserBounds, { id, bounds: null });
  document.body.classList.remove('dragging-task');
  tick(1);
  expect(invoke).toHaveBeenLastCalledWith(IPC.BrowserBounds, { id, bounds });
});
