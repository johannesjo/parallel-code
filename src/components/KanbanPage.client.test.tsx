import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import { KanbanPage } from './KanbanPage';
import { setBoardQuery } from './BoardSearch';
import { setStore, store } from '../store/core';
import { getTaskAttentionState } from '../store/taskStatus';
import { jumpToWaitingTask } from '../store/sidebar-attention';
import { setPrefillPrompt } from '../store/tasks';
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
    kanbanHideDetails: false,
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
vi.mock('../store/focused-panel', () => ({
  triggerFocus: vi.fn(),
  registerFocusFn: vi.fn(),
  unregisterFocusFn: vi.fn(),
}));
vi.mock('../store/taskStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/taskStatus')>()),
  getTaskAttentionState: vi.fn(() => 'idle'),
  getTaskDotStatus: vi.fn(() => 'waiting'),
  getReadyLabel: () => 'Ready',
}));
vi.mock('../store/agentHookStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/agentHookStatus')>()),
  getAgentHookStatus: () => null,
}));
vi.mock('../store/pr-checks-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/pr-checks-state')>()),
  getPrChecks: () => undefined,
}));
vi.mock('../store/sidebar-attention', () => ({
  computeAttentionEntries: () => [],
  jumpToWaitingTask: vi.fn(),
}));
vi.mock('../store/github-agent', () => ({
  ensureProjectAgentTask: vi.fn((id: string) => ({ id })),
}));
vi.mock('../store/tasks', () => ({ setPrefillPrompt: vi.fn(), uncollapseTask: vi.fn() }));
vi.mock('../store/github', () => ({ readGitHubIssue: vi.fn(async () => ({ state: 'open' })) }));
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
  // Saves read, write and read again; give each hop a turn.
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
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

/** Opens the board's more menu and picks the item that reads `label`. */
async function menuItem(label: string): Promise<void> {
  button('More actions').click();
  await settle();
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (el) => el.querySelector('.chat-menu-label')?.textContent === label,
  );
  if (!item) throw new Error(`No menu item ${label}`);
  item.click();
  await settle();
}

function cardEl(title: string): HTMLElement {
  const found = [...host.querySelectorAll<HTMLElement>('.plan-card')].find(
    (card) => card.querySelector('.task-board-name')?.textContent === title,
  );
  if (!found) throw new Error(`No card ${title}`);
  return found;
}

/** The card's title button, which takes the keyboard and opens the editor. */
function cardTitle(title: string): HTMLElement {
  const found = cardEl(title).querySelector<HTMLElement>('.task-board-title');
  if (!found) throw new Error(`No title on card ${title}`);
  return found;
}

function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
}

const columnNames = () =>
  [...host.querySelectorAll('.plan-lane .plan-lane-name')].map((h) => h.textContent);

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
      kanbanHideDetails: false,
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
    expect(host.querySelector('.task-board-rail')?.textContent).toContain('Archive');
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
      gitIsolation: 'worktree',
      agentIds: ['a1'],
      lastPrompt: 'implement the engine',
    } as unknown as Task);
    setStore('agents', 'a1', { def: { name: 'Claude Code' } } as never);
    vi.mocked(getTaskAttentionState).mockReturnValue('needs_input');
    await mount();
    const card = cardEl('Sync engine');
    expect(card.classList.contains('state-needs_input')).toBe(true);
    expect(card.textContent).toContain('Needs input');
    expect(card.querySelector('.task-board-activity')?.textContent).toBe('task/sync');
    expect(card.querySelector('.plan-task-name')?.textContent).toBe('Build sync engine');
    // A started card offers another run, not a first one.
    expect(card.querySelector('[aria-label="Start task"]')).toBeNull();
    expect(card.querySelector('[aria-label="Start another task from this card"]')).not.toBeNull();
    expect(button('Needs you 1').classList.contains('urgent')).toBe(true);
    button('Answer').click();
    expect(jumpToWaitingTask).toHaveBeenCalledWith('t1', null);
  });

  it('offers the shared task menu on a linked task', async () => {
    setStore('tasks', 't1', {
      id: 't1',
      name: 'Build sync engine',
      projectId: 'p1',
      branchName: 'task/sync',
      gitIsolation: 'worktree',
      agentIds: [],
    } as unknown as Task);
    await mount();
    cardEl('Sync engine')
      .querySelector('.plan-task')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 9, clientY: 9 }));
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map((item) =>
      item.textContent?.trim(),
    );
    expect(labels).toEqual(
      expect.arrayContaining(['Open', 'Open on the left', 'Finish and close', 'Close']),
    );
  });

  it('shows the plan as a mind map and opens a card from it in the board', async () => {
    setStore('tasks', 't1', {
      id: 't1',
      name: 'Build sync engine',
      projectId: 'p1',
      branchName: 'task/sync',
      gitIsolation: 'worktree',
      agentIds: [],
    } as unknown as Task);
    vi.mocked(getTaskAttentionState).mockReturnValue('needs_input');
    await mount();
    button('Map').click();
    await settle();
    expect(button('Map').getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('.plan-card')).toBeNull();
    const node = (title: string) => {
      const found = [...host.querySelectorAll<HTMLElement>('.investigation-node')].find(
        (n) => n.querySelector('strong')?.textContent === title,
      );
      if (!found) throw new Error(`No node ${title}`);
      return found;
    };
    expect(node('Backlog')).toBeTruthy();
    // The archive starts folded, as on the board.
    expect(() => node('Old card')).toThrow();
    const badge = host.querySelector<HTMLElement>('.kanban-map .graph-task-badge');
    expect(badge?.dataset.state).toBe('needs_input');
    expect(badge?.textContent).toBe('Needs input · Build sync engine');

    node('Docs').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle();
    expect(button('Board').getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Card title"]')?.value).toBe(
      'Docs',
    );
    // Leaving for the map would drop the open edit.
    expect(button('Map').disabled).toBe(true);
  });

  it('clusters the map by theme, set in the card editor or by the planning agent', async () => {
    await mount();
    button('Map').click();
    await settle();
    const node = (title: string) =>
      [...host.querySelectorAll<HTMLElement>('.investigation-node')].find(
        (n) => n.querySelector('strong')?.textContent === title,
      );
    button('Themes').click();
    await settle();
    expect(node('Backlog')).toBeUndefined();
    expect(node('No theme')).toBeTruthy();

    node('Docs')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle();
    const theme = host.querySelector<HTMLInputElement>('input[placeholder^="Cluster in the map"]');
    if (!theme) throw new Error('no theme field');
    theme.value = 'Handbook';
    theme.dispatchEvent(new Event('input', { bubbles: true }));
    theme.form?.requestSubmit();
    await settle();
    expect(disk.text).toContain('- [ ] Docs\n  group: Handbook\n');

    button('Map').click();
    await settle();
    expect(button('Themes').getAttribute('aria-pressed')).toBe('true');
    expect(node('Handbook')).toBeTruthy();

    button('Columns').click();
    button('Cluster with agent').click();
    await settle();
    expect(setPrefillPrompt).toHaveBeenCalledWith(
      'kanban-agent-p1',
      expect.stringContaining('group: <theme>'),
    );
    expect(button('Themes').getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('aside[aria-label="Planning agent"]')).not.toBeNull();
    // The view is kept per project across mounts; leave it as the other tests expect.
    button('Columns').click();
    button('Board').click();
    await settle();
  });

  it("names the page after the board's own title, if it has one", async () => {
    await mount();
    const section = host.querySelector('.kanban');
    expect(section?.getAttribute('aria-label')).toBe('Plan · Repo');
    dispose?.();

    disk.text = BOARD.replace('# Plan', '# Q4 roadmap');
    await mount();
    expect(host.querySelector('.kanban')?.getAttribute('aria-label')).toBe('Q4 roadmap · Repo');
  });

  it('offers to create the board when the project has none', async () => {
    disk.text = null;
    await mount();
    expect(host.textContent).toContain('Plan this project on a board');
    button('Create board').click();
    await settle();
    expect(disk.text).toContain('## Backlog');
    expect(host.querySelectorAll('.plan-lane')).toHaveLength(4);
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
    // Start sits in the card's corner, revealed on hover, so it takes no row of its own.
    expect(cardEl('Docs').querySelector('.plan-card-footer')).toBeNull();
    const start = cardEl('Docs').querySelector<HTMLButtonElement>('[aria-label="Start task"]');
    if (!start) throw new Error('No start button');
    start.click();
    expect(store.showNewTaskPanel).toBe(true);
    // The draft opens beside the plan, which stays.
    expect(store.kanbanProjectId).toBe('p1');
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
    expect(document.activeElement).toBe(cardTitle('Write migration'));
    press(cardTitle('Write migration'), 'j');
    await settle();
    expect(document.activeElement).toBe(cardTitle('Docs'));
    press(cardTitle('Docs'), 'x');
    await settle();
    expect(disk.text).toContain('- [x] Docs');
    press(cardTitle('Docs'), 'Delete');
    await settle();
    expect(disk.text).not.toContain('Docs');
    expect(host.querySelector('.kanban-undo')?.textContent).toContain('Deleted “Docs”');
    button('Undo').click();
    await settle();
    expect(disk.text).toContain('- [x] Docs');
  });

  it('moves the selected card to the next column with Shift+Right', async () => {
    await mount();
    cardTitle('Docs').focus();
    press(cardTitle('Docs'), 'ArrowRight', { shiftKey: true });
    await settle();
    expect(disk.text).toMatch(
      /## In progress\n\n- \[ \] Sync engine\n {2}branch: `task\/sync`\n- \[ \] Docs/,
    );
  });

  it('filters cards by text', async () => {
    await mount();
    // The query is shared with the running-tasks board.
    setBoardQuery('migration');
    await settle();
    expect(host.querySelectorAll('.plan-card')).toHaveLength(1);
    setBoardQuery('');
  });

  it('shows only the cards that need you while the toggle is pressed', async () => {
    setStore('tasks', 't1', {
      id: 't1',
      name: 'Build sync engine',
      projectId: 'p1',
      branchName: 'task/sync',
      gitIsolation: 'worktree',
      agentIds: [],
    } as unknown as Task);
    vi.mocked(getTaskAttentionState).mockReturnValue('needs_input');
    await mount();
    const toggle = button('Needs you 1');
    toggle.click();
    await settle();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(
      [...host.querySelectorAll('.plan-card .task-board-name')].map((c) => c.textContent),
    ).toEqual(['Sync engine']);
    // The filter is remembered per project; leave it off as the next tests expect.
    toggle.click();
  });

  it('hides card descriptions and checklists from the more menu', async () => {
    await mount();
    await menuItem('Hide details');
    const card = cardEl('Write migration');
    expect(card.textContent).not.toContain('Move the records.');
    expect(card.querySelector('.kanban-checklist')).toBeNull();
    expect(card.querySelector('.kanban-progress')?.textContent).toBe('0/1');
    expect(store.kanbanHideDetails).toBe(true);
    await menuItem('Show details');
    expect(cardEl('Write migration').textContent).toContain('Move the records.');
    expect(store.kanbanHideDetails).toBe(false);
  });

  it('keeps the file actions and keyboard help in the more menu', async () => {
    await mount();
    expect(() => button('Reload')).toThrow();
    await menuItem('Keyboard shortcuts');
    expect(host.querySelector('.kanban-help')).not.toBeNull();
  });

  it('opens the planning agent with a prefilled prompt', async () => {
    await mount();
    button('Plan with agent').click();
    await settle();
    // The board's own planner, not the GitHub page's agent.
    expect(setPrefillPrompt).toHaveBeenCalledWith(
      'kanban-agent-p1',
      expect.stringContaining('KANBAN.md'),
    );
    expect(host.querySelector('aside[aria-label="Planning agent"]')).not.toBeNull();
  });

  it('leaves an open new-task draft in place instead of opening the planner over it', async () => {
    setStore({ boardView: true, showNewTaskPanel: true } as never);
    await mount();
    button('Plan with agent').click();
    await settle();
    expect(host.querySelector('aside[aria-label="Planning agent"]')).toBeNull();
    expect(store.showNewTaskPanel).toBe(true);
    const { showNotification } = await import('../store/notification');
    expect(showNotification).toHaveBeenCalledWith(expect.stringContaining('new task'));
  });

  it('closes only the overlaid planner on Escape, not the plan', async () => {
    // A narrow window lays the planner over the board.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly cb: ResizeObserverCallback) {}
        observe() {
          this.cb([{ contentRect: { width: 600 } } as ResizeObserverEntry], this as never);
        }
        disconnect() {}
      },
    );
    await mount();
    button('Plan with agent').click();
    await settle();
    const pane = host.querySelector<HTMLElement>('aside[aria-label="Planning agent"]');
    if (!pane) throw new Error('No planner');
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    pane.dispatchEvent(esc);
    await settle();
    expect(host.querySelector('aside[aria-label="Planning agent"]')).toBeNull();
    // Handled here, so the app's own Escape does not close the plan too.
    expect(esc.defaultPrevented).toBe(true);
    vi.unstubAllGlobals();
  });

  it('re-applies a change on top of an edit made elsewhere', async () => {
    await mount();
    disk.text = BOARD.replace('- [ ] Docs', '- [ ] Edited elsewhere');
    const box = host.querySelector<HTMLInputElement>('input[aria-label="Done: Write migration"]');
    if (!box) throw new Error('no checkbox');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    // The change is re-applied to the file as it now is: nothing is lost.
    expect(disk.text).toContain('- [ ] Edited elsewhere');
    expect(disk.text).toContain('- [x] Write migration');
    expect(host.textContent).toContain('Edited elsewhere');
  });

  it('saves an edit made while the file changed elsewhere, onto the right card', async () => {
    await mount();
    cardTitle('Docs').click();
    await settle();
    const title = host.querySelector<HTMLInputElement>('input[aria-label="Card title"]');
    if (!title) throw new Error('no editor');
    // Another writer moves cards around while the editor is open.
    disk.text = BOARD.replace(
      '- [ ] Write migration',
      '- [ ] Inserted above\n- [ ] Write migration',
    );
    title.value = 'Docs v2';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    title.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(disk.text).toContain('- [ ] Inserted above');
    expect(disk.text).toContain('- [ ] Write migration');
    expect(disk.text).toContain('- [ ] Docs v2');
    expect(disk.text).not.toContain('- [ ] Docs\n');
  });

  it('never drags a card while another is being edited', async () => {
    await mount();
    cardTitle('Docs').click();
    await settle();
    expect(cardEl('Write migration').getAttribute('draggable')).toBe('false');
  });

  it('keeps keyboard actions on visible cards after a delete under a filter', async () => {
    await mount();
    setBoardQuery('docs');
    await settle();
    cardTitle('Docs').focus();
    press(cardTitle('Docs'), 'Delete');
    await settle();
    // Nothing visible is left, so a second Delete must not touch a hidden card.
    press(host.querySelector<HTMLElement>('.kanban') as HTMLElement, 'Delete');
    await settle();
    expect(disk.text).toContain('Write migration');
    setBoardQuery('');
    await settle();
  });

  it('closes an empty new-card field on Enter, so the keyboard keeps working', async () => {
    await mount();
    button('Add card').click();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="New card title"]');
    if (!input) throw new Error('no input');
    press(input, 'Enter');
    await settle();
    expect(host.querySelector('input[aria-label="New card title"]')).toBeNull();
    press(host.querySelector<HTMLElement>('.kanban') as HTMLElement, 'ArrowDown');
    await settle();
    expect(document.activeElement).toBe(cardTitle('Write migration'));
  });

  it('closes the editor when its column collapses', async () => {
    await mount();
    cardTitle('Docs').click();
    await settle();
    button('Collapse column Backlog').click();
    await settle();
    button('Expand column Backlog, 2 cards').click();
    await settle();
    expect(host.querySelector('form.kanban-card-editor')).toBeNull();
  });

  it('undoes a delete with the U key', async () => {
    await mount();
    cardTitle('Docs').focus();
    press(cardTitle('Docs'), 'Delete');
    await settle();
    expect(disk.text).not.toContain('Docs');
    press(host.querySelector<HTMLElement>('.kanban') as HTMLElement, 'u');
    await settle();
    expect(disk.text).toContain('- [ ] Docs');
  });

  it('shows a card’s GitHub issue', async () => {
    disk.text = BOARD.replace(
      '- [ ] Docs',
      '- [ ] Docs\n  issue: https://github.com/acme/app/issues/12',
    );
    await mount();
    expect(cardEl('Docs').querySelector('.kanban-issue')?.textContent).toContain('#12');
  });

  it('offers no undo when the delete could not be saved', async () => {
    await mount();
    const { invoke } = await import('../lib/ipc');
    vi.mocked(invoke).mockImplementationOnce(async () => {
      throw new Error('EACCES');
    });
    cardTitle('Docs').focus();
    press(cardTitle('Docs'), 'Delete');
    await settle();
    expect(host.querySelector('.kanban-undo.shown')).toBeNull();
    // The card is back on screen, read from disk.
    expect(cardEl('Docs')).toBeTruthy();
  });

  it('reports a save whose card was removed elsewhere instead of claiming Saved', async () => {
    await mount();
    cardTitle('Docs').click();
    await settle();
    disk.text = (disk.text ?? '').replace('- [ ] Docs\n', '');
    const title = host.querySelector<HTMLInputElement>('input[aria-label="Card title"]');
    if (!title) throw new Error('no editor');
    title.value = 'Docs v2';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    title.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    const { showNotification } = await import('../store/notification');
    expect(showNotification).toHaveBeenCalledWith(expect.stringContaining('Not saved'));
    expect(disk.text).not.toContain('Docs v2');
  });

  it('deletes the right one of two cards with the same title', async () => {
    disk.text = '## Backlog\n\n- [ ] Fix\n  alpha\n- [ ] Fix\n  beta\n';
    await mount();
    const second = [...host.querySelectorAll<HTMLElement>('.plan-card .task-board-title')][1];
    second.focus();
    // Another writer adds a card on top before the board reloads.
    disk.text = '## Backlog\n\n- [ ] New\n- [ ] Fix\n  alpha\n- [ ] Fix\n  beta\n';
    press(second, 'Delete');
    await settle();
    expect(disk.text).toContain('alpha');
    expect(disk.text).not.toContain('beta');
  });

  it('keeps typed text when the edited card moves while the editor is open', async () => {
    await mount();
    cardTitle('Sync engine').click();
    await settle();
    const title = host.querySelector<HTMLInputElement>('input[aria-label="Card title"]');
    if (!title) throw new Error('no editor');
    title.value = 'Sync engine v2';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    button('Delete column Backlog').click();
    await settle();
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Card title"]')?.value).toBe(
      'Sync engine v2',
    );
  });

  it('closes the editor when its column is renamed and then collapsed', async () => {
    await mount();
    cardTitle('Docs').click();
    await settle();
    disk.text = (disk.text ?? '').replace('## Backlog', '## Todo');
    button('Rename column Backlog').click();
    await settle();
    const field = host.querySelector<HTMLInputElement>('input[aria-label="Column name"]');
    if (!field) throw new Error('no rename field');
    field.value = 'Todo';
    press(field, 'Enter');
    await settle();
    button('Collapse column Todo').click();
    await settle();
    press(host.querySelector<HTMLElement>('.kanban') as HTMLElement, 'ArrowDown');
    await settle();
    expect(cardEl('Sync engine').getAttribute('draggable')).toBe('true');
  });

  it('closes the GitHub picker on Escape from its search field', async () => {
    await mount();
    await menuItem('Add from GitHub');
    const search = host.querySelector<HTMLInputElement>('.kanban-picker input');
    if (!search) throw new Error('no picker');
    press(search, 'Escape');
    await settle();
    expect(host.querySelector('.kanban-picker')).toBeNull();
  });
});
