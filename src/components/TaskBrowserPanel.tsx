import { Show, createEffect, createSignal, onCleanup, onMount, untrack } from 'solid-js';
import { createStore } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import type { BrowserAction, BrowserBounds, BrowserState } from '../../electron/shared/browser';
import { invoke } from '../lib/ipc';
import { topDialog } from '../lib/dialog-stack';
import { theme } from '../lib/theme';
import {
  appendBrowserReference,
  markBrowserFocused,
  setTaskBrowserUrl,
  setActiveTask,
  setTaskFocusedPanel,
} from '../store/store';
import './TaskBrowserPanel.css';

interface TaskBrowserPanelProps {
  taskId: string;
  initialUrl?: string;
  active: boolean;
  onClose: () => void;
}

/** A DOM placeholder positions the native view. Hide it during app overlays and
 * drags, and when clipped, since CSS cannot clip or cover a WebContentsView. */
function viewportBounds(el: HTMLElement): BrowserBounds | null {
  const r = el.getBoundingClientRect();
  if (
    r.width < 1 ||
    r.height < 1 ||
    r.left < 0 ||
    r.top < 0 ||
    r.right > window.innerWidth ||
    r.bottom > window.innerHeight
  )
    return null;
  if (
    document.body.classList.contains('dragging-task') ||
    document.querySelector('[role="dialog"], [role="menu"]')
  )
    return null;
  const points = [
    [r.left + 1, r.top + 1],
    [r.right - 1, r.top + 1],
    [r.left + 1, r.bottom - 1],
    [r.right - 1, r.bottom - 1],
    [r.left + r.width / 2, r.top + r.height / 2],
  ];
  if (points.some(([x, y]) => !el.contains(document.elementFromPoint(x, y)))) return null;
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

export function TaskBrowserPanel(props: TaskBrowserPanelProps) {
  const id = crypto.randomUUID();
  const [address, setAddress] = createSignal(props.initialUrl ?? 'http://localhost:3000');
  const [ready, setReady] = createSignal(false);
  const [error, setError] = createSignal('');
  const [state, setState] = createStore<BrowserState>({
    id,
    url: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    picking: false,
    error: null,
  });
  let viewport: HTMLDivElement | undefined;
  let disposed = false;
  let lastBounds = '';

  async function command(action: BrowserAction, url?: string): Promise<void> {
    setError('');
    try {
      await invoke(IPC.BrowserCommand, { id, action, ...(url === undefined ? {} : { url }) });
    } catch (e) {
      if (!disposed) setError(e instanceof Error ? e.message : 'Browser action failed.');
    }
  }
  function position(bounds: BrowserBounds | null): void {
    const key = `${window.devicePixelRatio}:${JSON.stringify(bounds)}`;
    if (key === lastBounds) return;
    lastBounds = key;
    void invoke(IPC.BrowserBounds, { id, bounds }).catch(() => {
      if (!disposed) setError('Could not position the preview.');
    });
  }

  onMount(() => {
    const taskId = props.taskId;
    const initialUrl = props.initialUrl;
    const onClose = props.onClose;
    const unsubscribe = window.electron.ipcRenderer.on(IPC.BrowserState, (value: unknown) => {
      const next = value as BrowserState;
      if (disposed || next.id !== id) return;
      if (next.closeRequested) {
        onClose();
        return;
      }
      // Do not overwrite an address the user is currently editing on a loading/picker update.
      if (next.url && next.url !== untrack(() => state.url)) {
        setAddress(next.url);
        setTaskBrowserUrl(taskId, next.url);
      }
      setState(next);
      if (next.focused) markBrowserFocused(taskId);
      if (next.reference) {
        appendBrowserReference(taskId, next.reference);
        setActiveTask(taskId);
        queueMicrotask(() => {
          if (!disposed) setTaskFocusedPanel(taskId, 'prompt');
        });
      }
    });
    void invoke(IPC.BrowserCommand, { id, taskId, action: 'create' })
      .then(() => {
        if (disposed) return;
        setReady(true);
        if (initialUrl) void command('navigate', initialUrl);
      })
      .catch(() => {
        if (!disposed) setError('Could not start the browser preview.');
      });
    onCleanup(() => {
      disposed = true;
      unsubscribe();
      void invoke(IPC.BrowserCommand, { id, action: 'close' }).catch(() => undefined);
    });
  });

  createEffect(() => {
    if (!ready()) return;
    if (!props.active || !state.url || state.error || topDialog()) {
      position(null);
      return;
    }
    let frame = 0;
    let dragging = false;
    const down = (event: MouseEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('.resize-handle, .task-title-bar')
      )
        return;
      dragging = true;
      position(null);
    };
    const up = () => {
      dragging = false;
    };
    const tick = () => {
      position(!dragging && viewport ? viewportBounds(viewport) : null);
      frame = requestAnimationFrame(tick);
    };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('mouseup', up, true);
    window.addEventListener('blur', up);
    tick();
    onCleanup(() => {
      cancelAnimationFrame(frame);
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('mouseup', up, true);
      window.removeEventListener('blur', up);
      position(null);
    });
  });

  return (
    <section
      class="task-browser-panel"
      aria-label="Task browser"
      style={{
        display: props.active ? 'flex' : 'none',
        background: theme.taskPanelBg,
        color: theme.fg,
      }}
    >
      <form
        class="task-browser-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          void command('navigate', address());
        }}
      >
        <button
          type="button"
          aria-label="Back"
          title="Back"
          disabled={!state.canGoBack}
          onClick={() => void command('back')}
        >
          ←
        </button>
        <button
          type="button"
          aria-label="Forward"
          title="Forward"
          disabled={!state.canGoForward}
          onClick={() => void command('forward')}
        >
          →
        </button>
        <button
          type="button"
          aria-label="Reload"
          title="Reload"
          disabled={!ready() || !state.url}
          onClick={() => void command('reload')}
        >
          ↻
        </button>
        <input
          aria-label="Browser address"
          value={address()}
          onInput={(event) => setAddress(event.currentTarget.value)}
          spellcheck={false}
        />
        <button type="submit" disabled={!ready()}>
          Go
        </button>
      </form>
      <div class="task-browser-actions">
        <button
          type="button"
          aria-pressed={state.picking}
          disabled={!ready() || !state.url || state.loading || !!state.error}
          onClick={() => void command('pick')}
        >
          {state.picking ? 'Cancel picker' : 'Pick element'}
        </button>
        <span role="status">
          {state.picking
            ? 'Click an element · Esc to cancel'
            : state.loading
              ? 'Loading…'
              : 'Add an element to your prompt'}
        </span>
      </div>
      <Show when={error() || state.error}>
        <div role="alert" class="task-browser-error">
          {error() || state.error}
        </div>
      </Show>
      <div ref={viewport} class="task-browser-viewport" aria-label="Browser page">
        <Show
          when={!state.url}
          fallback={
            <Show when={!state.error}>
              <p>Scroll the browser fully into view to show the page.</p>
            </Show>
          }
        >
          <p>Start your dev server in the task terminal, then enter its address above.</p>
        </Show>
      </div>
    </section>
  );
}
