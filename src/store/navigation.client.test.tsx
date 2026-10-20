// Where DOM focus goes when a column is clicked after moving through the sidebar.
// Real store, focus registry, sidebar navigation and title-bar drag handler; the
// column is reduced to a title, a terminal and an input, with a copy of
// TaskPanel's "respond to focus panel changes" effect (TerminalPanel's version
// only adds a 'terminal' default).
import { createEffect, For } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { store, setStore } from './core';
import { activateTaskFromPointer, setActiveTask } from './navigation';
import { registerFocusFn, scheduleTaskFocus, unregisterFocusFn } from './focused-panel';
import { focusSidebar, navigateRow } from './focus';
import { handleDragReorder } from '../lib/dragReorder';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('./persistence', () => ({ saveState: vi.fn() }));

const ids = ['task-a', 'task-b'];
const panel = (id: string) => `ai-terminal:${id}-agent`;
let dispose: (() => void) | undefined;
let sidebarEl!: HTMLDivElement;
const terminals: Record<string, HTMLTextAreaElement> = {};

function mount(activate: (id: string) => void) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  dispose = render(() => {
    createEffect(() => {
      if (store.sidebarFocused) sidebarEl.focus();
    });
    registerFocusFn('sidebar', () => sidebarEl.focus());
    return (
      <div>
        <div ref={sidebarEl} tabIndex={0} />
        <For each={ids}>
          {(id) => {
            createEffect(() => {
              if (store.activeTaskId !== id) return;
              const p = store.focusedPanel[id];
              if (p) scheduleTaskFocus(id, p);
            });
            registerFocusFn(`${id}:${panel(id)}`, () => terminals[id].focus());
            return (
              <div data-task-id={id} onClick={() => activate(id)}>
                <div
                  data-testid={`title-${id}`}
                  onMouseDown={(e) =>
                    handleDragReorder(e, {
                      itemId: id,
                      getTaskOrder: () => store.taskOrder,
                      onReorder: () => {},
                      onTap: () => activate(id),
                    })
                  }
                >
                  title
                </div>
                <textarea ref={(el) => (terminals[id] = el)} />
                <input data-testid={`input-${id}`} />
              </div>
            );
          }}
        </For>
      </div>
    );
  }, root);
}

function tapTitle(id: string) {
  const el = document.querySelector<HTMLElement>(`[data-testid="title-${id}"]`);
  if (!el) throw new Error(`no title for ${id}`);
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10 }));
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 10 }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, clientX: 10 }));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function moveIntoSidebar() {
  terminals['task-a'].focus();
  focusSidebar();
  navigateRow('down');
  await settle();
  expect(store.sidebarFocused).toBe(true);
  expect(document.activeElement).toBe(sidebarEl);
}

beforeEach(() => {
  setStore({
    tasks: Object.fromEntries(
      ids.map((id) => [
        id,
        {
          id,
          name: id,
          projectId: 'p',
          branchName: id,
          worktreePath: `/w/${id}`,
          agentIds: [`${id}-agent`],
          shellAgentIds: [],
          notes: '',
          lastPrompt: '',
          gitIsolation: 'worktree',
        },
      ]),
    ),
    taskOrder: [...ids],
    collapsedTaskOrder: [],
    projects: [{ id: 'p', name: 'p', path: '/p', color: '#fff' }] as never,
    terminals: {},
    focusedPanel: { 'task-a': panel('task-a'), 'task-b': panel('task-b') },
    activeTaskId: 'task-a',
    activeAgentId: 'task-a-agent',
    activeDocumentProjectId: null,
    newTaskPanelFocused: false,
    placeholderFocused: false,
    sidebarFocused: false,
    sidebarFocusedTaskId: null,
    sidebarFocusedProjectId: null,
  } as never);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = '';
  for (const id of ids) unregisterFocusFn(`${id}:${panel(id)}`);
});

// Control: a tap moves no DOM focus by itself (in the app the drag handler
// prevents the mousedown default; happy-dom moves none on mousedown either), so
// through setActiveTask alone focus stays on the sidebar.
it('setActiveTask leaves focus on the sidebar after a title tap', async () => {
  mount(setActiveTask);
  await moveIntoSidebar();
  tapTitle('task-b');
  await settle();
  expect(store.activeTaskId).toBe('task-b');
  expect(document.activeElement).toBe(sidebarEl);
});

it('a title tap on another column moves focus into it', async () => {
  mount(activateTaskFromPointer);
  await moveIntoSidebar();
  tapTitle('task-b');
  await settle();
  expect(store.sidebarFocused).toBe(false);
  expect(document.activeElement).toBe(terminals['task-b']);
});

// Nothing about the selection changes here, so the column's focus effect does
// not run again; the activation itself has to move focus back.
it('a title tap on the column that was already active moves focus back into it', async () => {
  mount(activateTaskFromPointer);
  await moveIntoSidebar();
  tapTitle('task-a');
  await settle();
  expect(store.sidebarFocused).toBe(false);
  expect(document.activeElement).toBe(terminals['task-a']);
});

// Only leaving the sidebar moves focus. A tap on the active column's title while
// focus is already somewhere in the column must leave it there.
it('leaves focus alone when the sidebar did not have it', async () => {
  mount(activateTaskFromPointer);
  await settle(); // let the active column's initial focus land first
  const input = document.querySelector<HTMLInputElement>('[data-testid="input-task-a"]');
  if (!input) throw new Error('no input');
  input.focus();
  tapTitle('task-a');
  await settle();
  expect(document.activeElement).toBe(input);
});
