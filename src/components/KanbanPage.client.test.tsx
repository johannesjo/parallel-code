import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import { KanbanPage } from './KanbanPage';
import { setStore, store } from '../store/core';
import { getTaskAttentionState } from '../store/taskStatus';
import { jumpToWaitingTask } from '../store/sidebar-attention';
import { prefillGitHubAgentPrompt } from '../store/github-agent';
import type { Task } from '../store/types';

const disk = vi.hoisted(() => ({ text: null as string | null }));

vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(async (channel: string, args: { content?: string; expected?: string | null }) => {
    if (channel === 'read_kanban_board') return disk.text;
    if (channel === 'write_kanban_board') {
      if (args.expected !== disk.text) throw new Error('KANBAN.md changed on disk');
      disk.text = args.content ?? null;
    }
    return undefined;
  }),
}));
vi.mock('../store/core', async () => {
  const { createStore } = await import('solid-js/store');
  const [store, setStore] = createStore({
    projects: [],
    tasks: {},
    agents: {},
    showNewTaskPanel: false,
    githubIssuesProjectId: null,
    kanbanProjectId: null,
    newTaskPrefillPrompt: null,
    editorCommand: '',
    panelUserSize: {},
  });
  return { store, setStore };
});
vi.mock('../store/navigation', async () => {
  const { setStore } = await import('../store/core');
  return {
    setActiveTask: vi.fn(),
    toggleNewTaskPanel: vi.fn((show: boolean) => setStore('showNewTaskPanel', show)),
  };
});
vi.mock('../store/projects', () => ({ getProjectPath: () => '/repo' }));
vi.mock('../store/notification', () => ({ showNotification: vi.fn() }));
vi.mock('../store/focused-panel', () => ({ triggerFocus: vi.fn() }));
vi.mock('../store/taskStatus', () => ({
  getTaskAttentionState: vi.fn(() => 'idle'),
  getReadyLabel: () => 'Ready',
}));
vi.mock('../store/agentHookStatus', () => ({ getAgentHookStatus: () => null }));
vi.mock('../store/pr-checks-state', () => ({ getPrChecks: () => undefined }));
vi.mock('../store/sidebar-attention', () => ({
  computeAttentionEntries: () => [],
  jumpToWaitingTask: vi.fn(),
}));
vi.mock('../store/github-agent', () => ({ prefillGitHubAgentPrompt: vi.fn(() => true) }));
// The agent terminal needs Electron; the pane's own behavior is covered on the GitHub page.
vi.mock('./GitHubAgentPane', async () => {
  const { createSignal } = await import('solid-js');
  return {
    createAgentPaneState: () => {
      const [open, setOpen] = createSignal(false);
      return { open, setOpen };
    },
    GitHubAgentPane: (props: { label?: string }) => <aside aria-label={props.label} />,
  };
});

const BOARD = `# Plan

## Backlog

- [ ] Write migration
  Move the records.
  - [ ] Old rows readable
  depends: Sync engine
- [ ] Docs

## In progress

- [ ] Sync engine
  branch: \`task/sync\`

## Done

## Archive

- [x] Old card
`;

let host: HTMLDivElement;
let dispose: (() => void) | undefined;

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function mount(): Promise<void> {
  dispose = render(() => <KanbanPage />, host);
  await settle();
}

function button(name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name,
  );
  if (!found) throw new Error(`No button ${name}`);
  return found;
}

function cardEl(title: string): HTMLElement {
  const found = host.querySelector<HTMLElement>(`.kanban-card[aria-label="${title}"]`);
  if (!found) throw new Error(`No card ${title}`);
  return found;
}

function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
}

const columnNames = () =>
  [...host.querySelectorAll('.kanban-column .kanban-column-name')].map((h) => h.textContent);

beforeEach(() => {
  disk.text = BOARD;
  vi.mocked(getTaskAttentionState).mockReturnValue('idle');
  host = document.createElement('div');
  document.body.append(host);
  setStore(
    reconcile({
      projects: [{ id: 'p1', name: 'Repo', path: '/repo', color: '#888' }],
      tasks: {},
      agents: {},
      showNewTaskPanel: false,
      githubIssuesProjectId: null,
      kanbanProjectId: 'p1',
      newTaskPrefillPrompt: null,
      editorCommand: '',
      panelUserSize: {},
    } as never),
  );
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  host.remove();
  vi.clearAllMocks();
});

describe('KanbanPage', () => {
  it('shows the columns and cards of KANBAN.md, with Archive collapsed', async () => {
    await mount();
    expect(columnNames()).toEqual(['Backlog', 'In progress', 'Done']);
    expect(host.querySelector('.kanban-column-collapsed')?.textContent).toContain('Archive');
    expect(host.textContent).toContain('Move the records.');
    expect(cardEl('Write migration').querySelector('.kanban-progress')?.textContent).toBe('0/1');
    expect(cardEl('Write migration').textContent).toContain('Waits for Sync engine');
    // No open task works on the recorded branch, so it shows as plain text.
    expect(host.querySelector('.kanban-branch')?.textContent).toBe('task/sync');
  });

  it('shows a linked task’s state and lets the user answer it from the card', async () => {
    setStore('tasks', 't1', {
      id: 't1',
      name: 'Build sync engine',
      projectId: 'p1',
      branchName: 'task/sync',
      agentIds: ['a1'],
      lastPrompt: 'implement the engine',
    } as unknown as Task);
    setStore('agents', 'a1', { def: { name: 'Claude Code' } } as never);
    vi.mocked(getTaskAttentionState).mockReturnValue('needs_input');
    await mount();
    const card = cardEl('Sync engine');
    expect(card.classList.contains('asking')).toBe(true);
    expect(card.textContent).toContain('Needs input');
    expect(card.querySelector('.kanban-task-activity')?.textContent).toBe('Claude Code');
    expect(host.querySelector('.kanban-summary.urgent')?.textContent).toBe('1 need you');
    button('Answer').click();
    expect(jumpToWaitingTask).toHaveBeenCalledWith('t1', null);
  });

  it('offers to create the board when the project has none', async () => {
    disk.text = null;
    await mount();
    expect(host.textContent).toContain('Plan this project on a board');
    button('Create board').click();
    await settle();
    expect(disk.text).toContain('## Backlog');
    expect(host.querySelectorAll('.kanban-column')).toHaveLength(4);
  });

  it('adds a card and writes it to the file', async () => {
    await mount();
    button('Add card').click();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="New card title"]');
    if (!input) throw new Error('no input');
    input.value = 'Tests';
    press(input, 'Enter');
    await settle();
    expect(disk.text).toContain('- [ ] Docs\n- [ ] Tests');
  });

  it('adds one card per line of a pasted list', async () => {
    await mount();
    button('Add card').click();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="New card title"]');
    if (!input) throw new Error('no input');
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: () => '- [ ] One\n- [ ] Two' },
    });
    input.dispatchEvent(paste);
    await settle();
    expect(paste.defaultPrevented).toBe(true);
    expect(disk.text).toContain('- [ ] Docs\n- [ ] One\n- [ ] Two');
  });

  it('checks a card and a checklist item off', async () => {
    await mount();
    const box = host.querySelector<HTMLInputElement>('input[aria-label="Done: Docs"]');
    if (!box) throw new Error('no checkbox');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(disk.text).toContain('- [x] Docs');
    const item =
      cardEl('Write migration').querySelector<HTMLInputElement>('.kanban-checklist input');
    item?.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(disk.text).toContain('  - [x] Old rows readable');
  });

  it('starts a task prefilled from the card', async () => {
    await mount();
    const start = cardEl('Docs').querySelector<HTMLButtonElement>('.kanban-start');
    start?.click();
    expect(store.showNewTaskPanel).toBe(true);
    expect(store.kanbanProjectId).toBeNull();
    expect(store.newTaskPrefillPrompt).toMatchObject({
      projectId: 'p1',
      name: 'Docs',
      kanban: { projectId: 'p1', title: 'Docs', column: 'Backlog' },
    });
  });

  it('is driven by the keyboard, and undoes a delete', async () => {
    await mount();
    const board = host.querySelector<HTMLElement>('.kanban');
    if (!board) throw new Error('no board');
    press(board, 'ArrowDown');
    await settle();
    expect(cardEl('Write migration').classList.contains('selected')).toBe(true);
    press(cardEl('Write migration'), 'j');
    await settle();
    expect(cardEl('Docs').classList.contains('selected')).toBe(true);
    press(cardEl('Docs'), 'x');
    await settle();
    expect(disk.text).toContain('- [x] Docs');
    press(cardEl('Docs'), 'Delete');
    await settle();
    expect(disk.text).not.toContain('Docs');
    expect(host.querySelector('.kanban-undo')?.textContent).toContain('Deleted “Docs”');
    button('Undo').click();
    await settle();
    expect(disk.text).toContain('- [x] Docs');
  });

  it('moves the selected card to the next column with Shift+Right', async () => {
    await mount();
    cardEl('Docs').focus();
    press(cardEl('Docs'), 'ArrowRight', { shiftKey: true });
    await settle();
    expect(disk.text).toMatch(
      /## In progress\n\n- \[ \] Sync engine\n {2}branch: `task\/sync`\n- \[ \] Docs/,
    );
  });

  it('filters cards by text and by state', async () => {
    await mount();
    const filter = host.querySelector<HTMLInputElement>('input[aria-label="Filter cards"]');
    if (!filter) throw new Error('no filter');
    filter.value = 'migration';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(host.querySelectorAll('.kanban-card')).toHaveLength(1);
    filter.value = '';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    button('Blocked').click();
    await settle();
    expect(
      [...host.querySelectorAll('.kanban-card')].map((c) => c.getAttribute('aria-label')),
    ).toEqual(['Write migration']);
    // The filter is remembered per project; leave it as the next test expects.
    button('All').click();
  });

  it('opens the planning agent with a prefilled prompt', async () => {
    await mount();
    button('Plan with agent').click();
    await settle();
    expect(prefillGitHubAgentPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1' }),
      expect.stringContaining('KANBAN.md'),
    );
    expect(host.querySelector('aside[aria-label="Planning agent"]')).not.toBeNull();
  });

  it('reloads after a refused write instead of overwriting', async () => {
    await mount();
    disk.text = BOARD.replace('- [ ] Docs', '- [ ] Edited elsewhere');
    const box = host.querySelector<HTMLInputElement>('input[aria-label="Done: Write migration"]');
    if (!box) throw new Error('no checkbox');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(disk.text).toContain('- [ ] Edited elsewhere');
    expect(host.textContent).toContain('Edited elsewhere');
  });
});
