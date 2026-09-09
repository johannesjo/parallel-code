import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setStore, store } from '../store/core';
import { clearAgentActivity } from '../store/taskStatus';
import { RightPanel } from './RightPanel';
import { ensureDocumentAgentTask } from './agent-task';
import { resetWorkspaceUi, setRailTab } from './workspace-ui';
import type { AgentDef } from '../ipc/types';
import type { Project } from '../store/types';

vi.mock('../components/TerminalView', () => ({
  TerminalView: (props: { visible?: boolean }) => (
    <div class="terminal-stub" data-visible={props.visible} />
  ),
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
  resetWorkspaceUi();
  setStore({
    projects: [],
    availableAgents: [],
    tasks: {},
    agents: {},
    activeTaskId: null,
    activeAgentId: null,
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

function mount(): HTMLElement {
  setStore({ availableAgents: [codex], projects: [project] });
  ensureDocumentAgentTask(project);
  const host = document.createElement('div');
  document.body.append(host);
  disposers.push(render(() => <RightPanel project={project} />, host));
  return host;
}

function tab(host: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (b) => b.textContent?.trim() === label,
    ) ?? null
  );
}

describe('RightPanel', () => {
  it('tells the terminal when it returns to the screen without remounting it', () => {
    const host = mount();
    const terminal = host.querySelector('.terminal-stub');
    expect(terminal?.getAttribute('data-visible')).toBe('true');

    tab(host, 'Files')?.click();
    expect(terminal?.getAttribute('data-visible')).toBe('false');

    tab(host, 'Agent')?.click();
    expect(host.querySelector('.terminal-stub')).toBe(terminal);
    expect(terminal?.getAttribute('data-visible')).toBe('true');
  });
  it('keeps the terminal mounted behind the other tabs', () => {
    const host = mount();
    const agentTab = host.querySelector('.docws-agent-tab');
    expect(host.querySelector('.terminal-stub')).not.toBeNull();
    expect(agentTab?.classList.contains('is-hidden')).toBe(false);

    tab(host, 'Runs')?.click();

    expect(tab(host, 'Runs')?.getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('.terminal-stub')).not.toBeNull();
    expect(agentTab?.classList.contains('is-hidden')).toBe(true);
    expect(host.textContent).toContain('Proposals show up here.');

    setRailTab('agent');

    expect(agentTab?.classList.contains('is-hidden')).toBe(false);
    expect(host.querySelector('.terminal-stub')).not.toBeNull();
  });
});
