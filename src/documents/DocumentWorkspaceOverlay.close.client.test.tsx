import { render } from 'solid-js/web';
import { Show, onCleanup, onMount } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setStore, store } from '../store/core';
import { addAgentToTask } from '../store/agents';
import { clearAgentActivity } from '../store/taskStatus';
import { DocumentWorkspaceOverlay } from './DocumentWorkspaceOverlay';
import { closeDocumentWorkspace, documentStore } from './store';
import { documentAgentTaskId, ensureDocumentAgentTask } from './agent-task';
import type { AgentDef } from '../ipc/types';
import type { Project } from '../store/types';

// The real terminal registers callbacks and hands them back from its cleanup,
// the way the terminal pane reads the task while the tree comes down.
vi.mock('../components/TerminalView', () => ({
  TerminalView: (props: {
    onStepNavReady?: (api: unknown) => void;
    onReady?: (fn: () => void) => void;
  }) => {
    onMount(() => {
      props.onReady?.(() => {});
      props.onStepNavReady?.({ mark: () => {}, jump: () => false });
    });
    onCleanup(() => props.onStepNavReady?.(undefined));
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

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
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

/** Mounted the way the app does it: the overlay lives inside a Show on the store. */
async function open(): Promise<HTMLElement> {
  setStore({ availableAgents: [codex], projects: [project], activeDocumentProjectId: 'docs' });
  const host = document.createElement('div');
  document.body.append(host);
  disposers.push(
    render(
      () => (
        <Show when={store.activeDocumentProjectId}>
          <DocumentWorkspaceOverlay />
        </Show>
      ),
      host,
    ),
  );
  await Promise.resolve();
  expect(host.querySelector('.terminal-stub')).not.toBeNull();
  expect(store.activeTaskId).toBe(documentAgentTaskId('docs'));
  return host;
}

describe('closing the workspace with the agent tab up', () => {
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
