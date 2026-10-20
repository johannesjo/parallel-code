import { beforeEach, expect, it, vi } from 'vitest';
import { ensureHiddenAgentTask } from '../documents/agent-task';
import { ensureGitHubAgentTask } from './github-agent';
import type { AgentDef } from '../ipc/types';
import type { Project } from './types';

const mockStore = vi.hoisted(() => ({
  availableAgents: [] as Partial<AgentDef>[],
  lastAgentId: null as string | null,
}));
vi.mock('./core', () => ({ store: mockStore }));
const loadState = vi.hoisted(() => ({ loaded: true, failed: false }));
vi.mock('./agents', () => ({
  agentsLoaded: () => loadState.loaded,
  agentsLoadFailed: () => loadState.failed,
}));
vi.mock('./tasks', () => ({ setPrefillPrompt: vi.fn() }));
vi.mock('../documents/agent-task', () => ({ ensureHiddenAgentTask: vi.fn(() => null) }));

const project = { id: 'p', name: 'Code', path: '/code' } as Project;
function pickedAgent(): AgentDef | undefined {
  ensureGitHubAgentTask(project);
  const pick = vi.mocked(ensureHiddenAgentTask).mock.calls[0]?.[2];
  return pick?.(project);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStore.lastAgentId = null;
});

it('runs as the hidden gh-agent task of the project', () => {
  ensureGitHubAgentTask(project);
  expect(ensureHiddenAgentTask).toHaveBeenCalledWith('gh-agent-p', project, expect.any(Function));
});

it('prefers an installed agent that can publish lists, the last used one first', () => {
  mockStore.availableAgents = [
    { id: 'gemini', command: 'gemini' },
    { id: 'codex', command: '/usr/bin/codex' },
    { id: 'claude', command: 'claude' },
    { id: 'old', command: 'copilot', available: false },
  ];
  expect(pickedAgent()?.id).toBe('codex');
  vi.clearAllMocks();
  mockStore.lastAgentId = 'claude';
  expect(pickedAgent()?.id).toBe('claude');
  vi.clearAllMocks();
  mockStore.lastAgentId = 'gemini';
  expect(pickedAgent()?.id).toBe('codex');
});

it('falls back to any installed agent', () => {
  mockStore.availableAgents = [{ id: 'gemini', command: 'gemini' }];
  expect(pickedAgent()?.id).toBe('gemini');
  vi.clearAllMocks();
  mockStore.availableAgents = [];
  expect(pickedAgent()).toBeUndefined();
});

it('reports whether any installed agent could run the task', async () => {
  const { canStartGitHubAgent } = await import('./github-agent');
  mockStore.availableAgents = [{ id: 'old', command: 'x', available: false }];
  expect(canStartGitHubAgent()).toBe(false);
  mockStore.availableAgents = [{ id: 'gemini', command: 'gemini' }];
  expect(canStartGitHubAgent()).toBe(true);
});

it('reports loading, failed, none and ready', async () => {
  const { githubAgentAvailability } = await import('./github-agent');
  mockStore.availableAgents = [{ id: 'gemini', command: 'gemini' }];
  loadState.loaded = false;
  expect(githubAgentAvailability()).toBe('loading');
  loadState.failed = true;
  expect(githubAgentAvailability()).toBe('failed');
  loadState.loaded = true;
  expect(githubAgentAvailability()).toBe('ready');
  mockStore.availableAgents = [];
  expect(githubAgentAvailability()).toBe('none');
});
