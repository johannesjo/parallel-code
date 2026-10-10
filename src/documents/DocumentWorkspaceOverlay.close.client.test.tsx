import { render } from 'solid-js/web';
import { onCleanup, onMount } from 'solid-js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setStore, store } from '../store/core';
import { addAgentToTask } from '../store/agents';
import { clearAgentActivity } from '../store/taskStatus';
import { TilingLayout } from '../components/TilingLayout';
import { jumpToTask, setActiveTask } from '../store/navigation';
import { closeDocumentWorkspace, documentStore } from './store';
import { documentAgentTaskId, ensureDocumentAgentTask } from './agent-task';
import type { AgentDef } from '../ipc/types';
import type { Project } from '../store/types';

vi.mock('../components/TaskPanel', () => ({ TaskPanel: () => <div>Code task</div> }));

// The real terminal registers callbacks and hands them back from its cleanup,
// the way the terminal pane reads the task while the tree comes down.
vi.mock('../components/TerminalView', () => ({
  TerminalView: (props: {
    onTranscriptMarksReady?: (api: unknown) => void;
    onReady?: (fn: () => void) => void;
  }) => {
    onMount(() => {
      props.onReady?.(() => {});
      props.onTranscriptMarksReady?.({ mark: () => {}, jump: () => false });
    });
    onCleanup(() => props.onTranscriptMarksReady?.(undefined));
    return <div class="terminal-stub" />;
  },
}));
vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(() => Promise.resolve([])),
  Channel: class {
    dispose() {}
  },
}));
vi.mock('../lib/shell', () => ({ openInEditor: vi.fn(), revealItemInDir: vi.fn() }));

const disposers: Array<() => void> = [];

// TilingLayout lazy-loads the document panel; transform it before the tests poll for it.
beforeAll(async () => {
  await import('./DocumentWorkspacePanel');
});

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  for (const id of Object.keys(store.agents)) clearAgentActivity(id);
  setStore({
    projects: [],
    availableAgents: [],
    tasks: {},
    agents: {},
    taskOrder: [],
    activeTaskId: null,
    activeAgentId: null,
    activeDocumentProjectId: null,
    focusMode: false,
  });
});

const codex: AgentDef = {
  id: 'codex',
  name: 'Codex',
  command: 'codex',
  args: [],
  resume_args: [],
  skip_permissions_args: [],
  description: '',
};

const project: Project = {
  id: 'docs',
  name: 'Docs',
  path: '/projects/docs',
  color: '',
  kind: 'document',
  documentPath: 'notes.md',
  documentTerminalAgentId: 'codex',
};

/** Mount through the real tiling layout to exercise workspace lifetime. */
async function open(): Promise<HTMLElement> {
  setStore({ availableAgents: [codex], projects: [project], activeDocumentProjectId: 'docs' });
  const host = document.createElement('div');
  document.body.append(host);
  disposers.push(render(() => <TilingLayout />, host));
  await vi.waitFor(() => expect(host.querySelector('.terminal-stub')).not.toBeNull());
  expect(store.activeTaskId).toBe(documentAgentTaskId('docs'));
  return host;
}

describe('document panel lifetime', () => {
  it('restores document prompt focus when selected by its number shortcut', async () => {
    const host = await open();
    setStore('tasks', 'code', {
      id: 'code',
      name: 'Code',
      projectId: 'docs',
      branchName: '',
      worktreePath: '/code',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
    });
    setStore('taskOrder', ['code']);
    setStore('focusedPanel', documentAgentTaskId('docs'), 'prompt');
    setActiveTask('code');
    const otherInput = document.createElement('textarea');
    document.body.append(otherInput);
    otherInput.focus();
    jumpToTask(1);
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(host.querySelector('.docws-agent-prompt textarea')),
    );
  });

  it('keeps the terminal mounted when resizing between stacked and wide layouts', async () => {
    let resize: ((width: number) => void) | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private callback: ResizeObserverCallback) {}
        observe(target: Element) {
          if (target.classList.contains('docws-workspace')) {
            resize = (width) =>
              this.callback([{ target, contentRect: { width } } as ResizeObserverEntry], this);
          }
        }
        unobserve() {}
        disconnect() {}
      },
    );
    const host = await open();
    const terminal = host.querySelector('.terminal-stub');
    expect(resize).toBeDefined();
    expect(host.querySelector('.docws-body .resize-handle-v')).not.toBeNull();
    resize?.(1000);
    expect(host.querySelector('.docws-body .resize-handle-h')).not.toBeNull();
    expect(host.querySelector('.terminal-stub')).toBe(terminal);
    resize?.(520);
    expect(host.querySelector('.docws-body .resize-handle-v')).not.toBeNull();
    expect(host.querySelector('.terminal-stub')).toBe(terminal);
  });

  it('keeps the agent mounted across task switches, focus mode and document project switches', async () => {
    const host = await open();
    const terminal = host.querySelector('.terminal-stub');
    setStore('tasks', 'code', {
      id: 'code',
      name: 'Code',
      projectId: 'docs',
      branchName: '',
      worktreePath: '/code',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
    });
    setStore('taskOrder', ['code']);
    setActiveTask('code');
    expect(store.activeDocumentProjectId).toBe('docs');
    setStore('availableAgents', [{ ...codex, description: 'Refreshed definition' }]);
    expect(store.activeTaskId).toBe('code');
    expect(host.querySelector('.terminal-stub')).toBe(terminal);
    setStore('focusMode', true);
    setActiveTask(documentAgentTaskId('docs'));
    setStore('focusMode', false);
    expect(host.querySelector('.terminal-stub')).toBe(terminal);
    setStore('projects', (projects) => [...projects, { ...project, id: 'other', name: 'Other' }]);
    setStore('activeDocumentProjectId', 'other');
    expect(store.activeTaskId).toBe(documentAgentTaskId('other'));
    expect(store.activeDocumentProjectId).toBe('other');
    expect(host.querySelectorAll('.docws-workspace')).toHaveLength(1);
    expect(host.querySelector('.terminal-stub')).not.toBe(terminal);
    setActiveTask('code');
    closeDocumentWorkspace();
    expect(store.activeTaskId).toBe('code');
    expect(host.querySelector('.terminal-stub')).toBeNull();
  });
  it('takes the terminal down cleanly', async () => {
    const host = await open();

    expect(() => closeDocumentWorkspace()).not.toThrow();

    expect(host.querySelector('.terminal-stub')).toBeNull();
    expect(documentStore.projectId).toBeNull();
    expect(store.activeTaskId).toBeNull();
  });

  it('takes two terminals down cleanly', async () => {
    const host = await open();
    const task = ensureDocumentAgentTask(project);
    await addAgentToTask(task?.id ?? '', codex);
    expect(host.querySelectorAll('.terminal-stub').length).toBe(2);

    expect(() => closeDocumentWorkspace()).not.toThrow();

    expect(host.querySelector('.terminal-stub')).toBeNull();
  });
});
