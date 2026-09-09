import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setStore, store } from '../store/core';
import { restartAgent } from '../store/agents';
import { setInitialPrompt } from '../store/tasks';
import { clearAgentActivity, markAgentOutput } from '../store/taskStatus';
import { AgentTerminal } from './AgentTerminal';
import { documentAgentTaskId, ensureDocumentAgentTask } from './agent-task';
import type { AgentDef } from '../ipc/types';
import type { Project } from '../store/types';

const { openDocumentFile } = vi.hoisted(() => ({ openDocumentFile: vi.fn() }));

vi.mock('../components/TerminalView', () => ({
  TerminalView: (props: { onFileLink?: (filePath: string) => void }) => (
    <div class="terminal-stub">
      <button class="link-inside" onClick={() => props.onFileLink?.('/projects/docs/guide.md')} />
      <button class="link-outside" onClick={() => props.onFileLink?.('/elsewhere/guide.md')} />
    </div>
  ),
}));
vi.mock('./store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store')>()),
  openDocumentFile,
}));

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
    activeTaskId: null,
    activeAgentId: null,
  });
  vi.clearAllMocks();
});

const agent = (id: string, name: string): AgentDef => ({
  id,
  name,
  command: id,
  args: [],
  resume_args: [],
  skip_permissions_args: [],
  description: '',
});

function mount(agents: AgentDef[], terminalAgentId?: string, path = '/projects/docs'): HTMLElement {
  setStore({
    availableAgents: agents,
    projects: [
      {
        id: 'docs',
        name: 'Docs',
        path,
        color: '',
        kind: 'document',
        documentPath: 'notes.md',
        documentTerminalAgentId: terminalAgentId,
      },
    ],
  });
  ensureDocumentAgentTask(store.projects[0] as Project);
  const host = document.createElement('div');
  document.body.append(host);
  disposers.push(render(() => <AgentTerminal project={store.projects[0] as Project} />, host));
  return host;
}

describe('AgentTerminal', () => {
  it('shows the task terminal with its prompt bar, agent chip and prompt box', () => {
    const host = mount([agent('claude-code', 'Claude Code'), agent('codex', 'Codex')], 'codex');

    expect(host.querySelector('.terminal-stub')).not.toBeNull();
    expect(host.textContent).toContain('No prompts sent');
    expect(host.textContent).toContain('Codex');
    expect(host.querySelector('textarea.prompt-textarea')).not.toBeNull();
  });

  it('remembers the agent it runs on the project', () => {
    mount([agent('codex', 'Codex')]);
    expect(store.projects[0].documentTerminalAgentId).toBe('codex');
  });

  it('attaches to the session again when shown after a restart', () => {
    mount([agent('codex', 'Codex')]);
    const id = documentAgentTaskId('docs');
    restartAgent(id, false);
    expect(store.agents[id]?.attachExisting).toBe(false);
    disposers.pop()?.();

    mount([agent('codex', 'Codex')]);

    expect(store.agents[id]?.attachExisting).toBe(true);
  });

  it('resumes an agent that exited when shown again', () => {
    mount([agent('codex', 'Codex')]);
    const id = documentAgentTaskId('docs');
    setStore('agents', id, { status: 'exited', exitCode: 1 });
    disposers.pop()?.();

    const host = mount([agent('codex', 'Codex')]);

    expect(store.agents[id]?.status).toBe('running');
    expect(store.agents[id]?.exitCode).toBeNull();
    expect(store.agents[id]?.resumed).toBe(true);
    expect(host.textContent).not.toContain('exited');
  });

  it('prepares resume if the process exits while the workspace is closed', () => {
    mount([agent('codex', 'Codex')]);
    const id = documentAgentTaskId('docs');
    expect(store.agents[id]?.resumed).toBe(false);
    disposers.pop()?.();
    // No mounted terminal receives the background process's exit event.
    mount([agent('codex', 'Codex')]);
    expect(store.agents[id]?.attachExisting).toBe(true);
    expect(store.agents[id]?.resumed).toBe(true);
  });

  it('keeps queued instructions manual when reopening may show a session picker', () => {
    mount([agent('codex', 'Codex')]);
    const id = documentAgentTaskId('docs');
    setInitialPrompt(id, 'Keep this instruction');
    disposers.pop()?.();
    const host = mount([agent('codex', 'Codex')]);
    expect(host.querySelector<HTMLTextAreaElement>('.prompt-textarea')?.value).toBe(
      'Keep this instruction',
    );
    expect(host.textContent).toContain('Review the terminal session before sending');
    expect(store.tasks[id]?.initialPrompt).toBe('Keep this instruction');
  });

  it('does not replace a typed draft with a queued instruction on resume', () => {
    mount([agent('codex', 'Codex')]);
    const id = documentAgentTaskId('docs');
    setInitialPrompt(id, 'Queued instruction');
    disposers.pop()?.();
    setStore('tasks', id, 'promptDraft', 'My unsent draft');
    const host = mount([agent('codex', 'Codex')]);
    expect(host.querySelector<HTMLTextAreaElement>('.prompt-textarea')?.value).toBe(
      'My unsent draft',
    );
    expect(store.tasks[id]?.initialPrompt).toBe('Queued instruction');
  });

  it('opens a Markdown path inside the project in the viewer, others elsewhere', () => {
    const host = mount([agent('codex', 'Codex')]);

    host.querySelector<HTMLButtonElement>('.link-inside')?.click();
    expect(openDocumentFile).toHaveBeenCalledWith('guide.md');

    host.querySelector<HTMLButtonElement>('.link-outside')?.click();
    expect(openDocumentFile).toHaveBeenCalledTimes(1);
  });

  it('opens a path inside a project that was added with a trailing slash', () => {
    const host = mount([agent('codex', 'Codex')], undefined, '/projects/docs/');

    host.querySelector<HTMLButtonElement>('.link-inside')?.click();
    expect(openDocumentFile).toHaveBeenCalledWith('guide.md');
  });

  it('says to answer the agent while the first instruction waits behind a question', () => {
    const host = mount([agent('codex', 'Codex')]);
    const id = documentAgentTaskId('docs');
    setInitialPrompt(id, 'Tighten this.');
    expect(host.textContent).toContain('Waiting to send prompt');

    markAgentOutput(id, new TextEncoder().encode('Continue? [Y/n]'), id);

    expect(host.textContent).toContain('Answer the agent to send the queued prompt');
  });

  it('says so when no agent is installed', () => {
    const host = mount([]);
    expect(host.textContent).toContain('No agent is installed.');
    expect(host.querySelector('.terminal-stub')).toBeNull();
  });
});
