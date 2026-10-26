import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/dialog', () => ({
  confirm: vi.fn(),
  openDialog: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(),
}));

vi.mock('./tasks', () => ({
  closeTask: vi.fn(),
}));

vi.mock('./github-list-storage', () => ({
  forgetGitHubLists: vi.fn(),
}));

import { produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { setStore, store } from './core';
import {
  addDocumentProject,
  addProject,
  addQuickEditProject,
  relinkProject,
  removeProject,
  pickAndAddProject,
  updateProject,
  updateProjectCoordination,
} from './projects';
import { openDialog } from '../lib/dialog';
import type { Task } from './types';
import { blockEditIn, startBlockEdit } from '../documents/block-edit-state';
import type { DocumentBlock } from '../documents/markdown-blocks';

describe('pickAndAddProject', () => {
  afterEach(() => {
    setStore({ projects: [] });
    vi.clearAllMocks();
  });

  it('opens one folder dialog however often it is asked while one is open', async () => {
    let choose: (path: string | null) => void = () => undefined;
    vi.mocked(openDialog).mockReturnValueOnce(new Promise((r) => (choose = r)));
    const first = pickAndAddProject();
    expect(await pickAndAddProject()).toBeNull();
    choose(null);
    expect(await first).toBeNull();
    expect(openDialog).toHaveBeenCalledTimes(1);

    vi.mocked(openDialog).mockResolvedValueOnce(null);
    await pickAndAddProject();
    expect(openDialog).toHaveBeenCalledTimes(2);
  });
});

describe('relinkProject document terminals', () => {
  afterEach(() => {
    setStore({ projects: [], tasks: {}, agents: {}, activeDocumentProjectId: null });
    vi.clearAllMocks();
  });

  it('stops old sessions and updates the hidden task without losing its draft', async () => {
    setStore('projects', [
      {
        id: 'docs',
        name: 'Docs',
        path: '/old',
        color: '',
        kind: 'document',
        documentPath: 'notes.md',
      },
    ]);
    setStore('tasks', 'doc-agent-docs', {
      id: 'doc-agent-docs',
      projectId: 'docs',
      name: 'Docs',
      worktreePath: '/old',
      branchName: '',
      agentIds: ['a'],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
      promptDraft: 'Keep this draft',
    });
    setStore('agents', 'a', {
      id: 'a',
      taskId: 'doc-agent-docs',
      def: {
        id: 'codex',
        name: 'Codex',
        command: 'codex',
        args: [],
        resume_args: ['resume', '--last'],
        skip_permissions_args: [],
        description: '',
      },
      resumed: true,
      attachExisting: true,
      generation: 2,
      status: 'exited',
      exitCode: 1,
      signal: null,
      lastOutput: ['old output'],
    });
    vi.mocked(openDialog).mockResolvedValue('/new');
    vi.mocked(invoke).mockImplementation(async (channel) => {
      if (channel === IPC.KillAgent) expect(store.projects[0].path).toBe('/old');
      return true;
    });
    expect(await relinkProject('docs')).toBe(true);
    expect(invoke).toHaveBeenCalledWith(IPC.KillAgent, { agentId: 'a' });
    expect(store.tasks['doc-agent-docs']).toMatchObject({
      worktreePath: '/new',
      promptDraft: 'Keep this draft',
    });
    expect(store.agents.a).toMatchObject({
      resumed: false,
      attachExisting: false,
      generation: 3,
      status: 'running',
      exitCode: null,
      lastOutput: [],
    });
  });

  it('does not change folders when an old session cannot be stopped', async () => {
    setStore('projects', [
      {
        id: 'docs',
        name: 'Docs',
        path: '/old',
        color: '',
        kind: 'document',
        documentPath: 'notes.md',
      },
    ]);
    setStore('tasks', 'doc-agent-docs', {
      id: 'doc-agent-docs',
      projectId: 'docs',
      name: 'Docs',
      worktreePath: '/old',
      branchName: '',
      agentIds: ['a'],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
    });
    vi.mocked(openDialog).mockResolvedValue('/new');
    vi.mocked(invoke).mockImplementation(async (channel) => {
      if (channel === IPC.KillAgent) throw new Error('Cannot stop session');
      return true;
    });
    await expect(relinkProject('docs')).rejects.toThrow('Cannot stop session');
    expect(store.projects[0].path).toBe('/old');
    expect(store.tasks['doc-agent-docs'].worktreePath).toBe('/old');
  });
});

// Moving a project starts the pane on a fresh conversation (`resumed = false`),
// which means the relaunch passes `--session-id`. Claude rejects that flag for
// a session that already exists, so carrying the old id across the move would
// stop the pane launching at all.
describe('relinkProject session ids', () => {
  afterEach(() => {
    setStore({ projects: [], tasks: {}, agents: {}, activeDocumentProjectId: null });
    vi.clearAllMocks();
  });

  function seed(command: string, sessionId: string | undefined) {
    setStore('projects', [
      {
        id: 'docs',
        name: 'Docs',
        path: '/old',
        color: '',
        kind: 'document',
        documentPath: 'notes.md',
      },
    ]);
    setStore('tasks', 'doc-agent-docs', {
      id: 'doc-agent-docs',
      projectId: 'docs',
      name: 'Docs',
      worktreePath: '/old',
      branchName: '',
      agentIds: ['a'],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
      agentSessionIds: sessionId ? { a: sessionId } : undefined,
    } as unknown as Task);
    setStore('agents', 'a', {
      id: 'a',
      taskId: 'doc-agent-docs',
      def: {
        id: 'claude',
        name: 'Claude',
        command,
        args: [],
        resume_args: [],
        skip_permissions_args: [],
        description: '',
      },
      resumed: true,
      generation: 1,
      status: 'exited',
      exitCode: 1,
      signal: null,
      lastOutput: [],
    });
    vi.mocked(openDialog).mockResolvedValue('/new');
    vi.mocked(invoke).mockResolvedValue(true);
  }

  it('replaces the id the pane already used', async () => {
    const used = 'fb4f2bc6-62d9-4b29-a795-240caf2fc459';
    seed('claude', used);
    expect(await relinkProject('docs')).toBe(true);
    const after = store.tasks['doc-agent-docs'].agentSessionIds?.a;
    expect(after).toEqual(expect.any(String));
    expect(after).not.toBe(used);
  });

  it('gives a pane that had no id one to use', async () => {
    seed('claude', undefined);
    expect(await relinkProject('docs')).toBe(true);
    expect(store.tasks['doc-agent-docs'].agentSessionIds?.a).toEqual(expect.any(String));
  });

  it('drops the prompts sent to the conversation it replaced', async () => {
    seed('claude', undefined);
    setStore('tasks', 'doc-agent-docs', {
      lastPrompt: 'old',
      promptHistory: [{ text: 'old', agentId: 'a' }],
    });
    expect(await relinkProject('docs')).toBe(true);
    expect(store.tasks['doc-agent-docs'].promptHistory).toBeUndefined();
    expect(store.tasks['doc-agent-docs'].lastPrompt).toBe('');
  });

  // Codex assigns its own, so an id invented here would name a session that
  // never existed.
  it('leaves a Codex pane without one', async () => {
    seed('codex', undefined);
    expect(await relinkProject('docs')).toBe(true);
    expect(store.tasks['doc-agent-docs'].agentSessionIds?.a).toBeUndefined();
  });
});

describe('updateProject', () => {
  afterEach(() => {
    setStore('projects', []);
  });

  it('clears the configured coverage report path when undefined is provided', () => {
    setStore('projects', [
      {
        id: 'p1',
        name: 'Project',
        path: '/repo',
        color: 'hsl(0, 70%, 75%)',
        coverageReportPath: 'coverage/lcov.info',
      },
    ]);

    updateProject('p1', { coverageReportPath: undefined });

    expect(store.projects[0]?.coverageReportPath).toBeUndefined();
  });

  it('clears the default base branch when undefined is provided', () => {
    setStore('projects', [
      {
        id: 'p1',
        name: 'Project',
        path: '/repo',
        color: 'hsl(0, 70%, 75%)',
        defaultBaseBranch: 'main',
      },
    ]);

    updateProject('p1', { defaultBaseBranch: undefined });

    expect(store.projects[0]?.defaultBaseBranch).toBeUndefined();
  });

  it('sets the worktree folder and clears it when undefined is provided', () => {
    setStore('projects', [{ id: 'p1', name: 'Project', path: '/repo', color: 'hsl(0, 70%, 75%)' }]);

    updateProject('p1', { worktreeFolder: '~/worktrees/repo' });
    expect(store.projects[0]?.worktreeFolder).toBe('~/worktrees/repo');

    updateProject('p1', { name: 'Renamed' });
    expect(store.projects[0]?.worktreeFolder).toBe('~/worktrees/repo');

    updateProject('p1', { worktreeFolder: undefined });
    expect(store.projects[0]?.worktreeFolder).toBeUndefined();
  });

  it('sets an icon and clears it when undefined is provided', () => {
    setStore('projects', [{ id: 'p1', name: 'Project', path: '/repo', color: 'hsl(0, 70%, 75%)' }]);

    updateProject('p1', { icon: 'terminal' });
    expect(store.projects[0]?.icon).toBe('terminal');

    updateProject('p1', { icon: undefined });
    expect(store.projects[0]?.icon).toBeUndefined();
  });
});

describe('updateProject verify command', () => {
  const project = (id: string, verifyCommand?: string) => ({
    id,
    name: id,
    path: `/${id}`,
    color: 'hsl(0, 70%, 75%)',
    verifyCommand,
  });
  const coordinator = (
    id: string,
    projectId: string,
    mcpStartupStatus: Task['mcpStartupStatus'],
  ): Task => ({
    id,
    name: id,
    projectId,
    branchName: `task/${id}`,
    worktreePath: `/${projectId}/.worktrees/${id}`,
    agentIds: [],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    gitIsolation: 'worktree',
    coordinatorMode: true,
    mcpStartupStatus,
  });

  afterEach(() => {
    setStore('projects', []);
    setStore(
      produce((s) => {
        s.tasks = {};
      }),
    );
    vi.mocked(invoke).mockReset();
  });

  it('pushes a changed command to the ready coordinators of that project only', () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    setStore('projects', [project('p1', 'npm test'), project('p2', 'npm test')]);
    setStore('tasks', {
      ready: coordinator('ready', 'p1', 'ready'),
      pending: coordinator('pending', 'p1', 'pending'),
      other: coordinator('other', 'p2', 'ready'),
      plain: { ...coordinator('plain', 'p1', 'ready'), coordinatorMode: false },
    });

    updateProject('p1', { verifyCommand: undefined });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      IPC.MCP_CoordinatorRegistered,
      expect.objectContaining({ coordinatorTaskId: 'ready', projectId: 'p1', verifyCommand: '' }),
    );
  });

  it('leaves coordinators alone when the command is unchanged', () => {
    setStore('projects', [project('p1', 'npm test')]);
    setStore('tasks', { ready: coordinator('ready', 'p1', 'ready') });

    updateProject('p1', { verifyCommand: 'npm test', name: 'Renamed' });

    expect(invoke).not.toHaveBeenCalled();
  });
});

it('changes project peer permission only after backend acknowledgment', async () => {
  setStore('projects', [
    {
      id: 'consent',
      name: 'Consent',
      path: '/repo',
      color: '',
      allowPeerAccess: false,
    },
  ]);
  vi.mocked(invoke).mockRejectedValueOnce(new Error('Permission update failed'));
  await expect(updateProjectCoordination('consent', true)).rejects.toThrow(
    'Permission update failed',
  );
  expect(store.projects[0].allowPeerAccess).toBe(false);
  vi.mocked(invoke).mockResolvedValueOnce({});
  await updateProjectCoordination('consent', true);
  expect(invoke).toHaveBeenLastCalledWith(IPC.DelegationRequest, {
    action: 'projectPolicy',
    policy: { projectId: 'consent', allowPeerAccess: true },
  });
  expect(store.projects[0].allowPeerAccess).toBe(true);
});

describe('quick edit projects', () => {
  afterEach(() => {
    setStore({ projects: [], tasks: {}, taskOrder: [], collapsedTaskOrder: [] });
    vi.clearAllMocks();
  });

  it('names a quick edit after its file and folder, and stops its sync on removal', () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const id = addQuickEditProject({
      projectRoot: '/data/quick-edits/abc',
      documentPath: 'spec.md',
      sourcePath: '/work/app/docs/spec.md',
    });
    expect(store.projects.find((p) => p.id === id)).toMatchObject({
      name: 'spec.md · docs',
      quickEditSource: '/work/app/docs/spec.md',
    });

    removeProject(id);
    expect(invoke).toHaveBeenCalledWith(IPC.StopQuickEdit, {
      projectRoot: '/data/quick-edits/abc',
    });
    expect(store.projects.some((p) => p.id === id)).toBe(false);
  });

  it("keeps a removed project's ideas, no longer tied to it", () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    setStore('projects', [{ id: 'gone', name: 'Gone', path: '/gone', color: '#000' }]);
    setStore('taskIdeas', [{ id: 'i1', text: 'Dark mode', projectId: 'gone', createdAt: 1 }]);

    removeProject('gone');

    expect(store.taskIdeas).toEqual([
      { id: 'i1', text: 'Dark mode', projectId: null, createdAt: 1 },
    ]);
  });

  it("forgets a removed project's block edits, so a re-added one starts clean", () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const id = addQuickEditProject({
      projectRoot: '/data/quick-edits/def',
      documentPath: 'spec.md',
      sourcePath: '/work/app/docs/spec.md',
    });
    startBlockEdit({
      projectRoot: '/data/quick-edits/def',
      documentPath: 'spec.md',
      source: 'Text.\n',
      block: { index: 0, raw: 'Text.\n' } as DocumentBlock,
    });

    removeProject(id);

    expect(blockEditIn('/data/quick-edits/def', 'spec.md')).toBeNull();
  });

  it("forgets the block edits left at a relinked project's old path", async () => {
    const id = addDocumentProject('spec', '/work/before', 'spec.md');
    startBlockEdit({
      projectRoot: '/work/before',
      documentPath: 'spec.md',
      source: 'Text.\n',
      block: { index: 0, raw: 'Text.\n' } as DocumentBlock,
    });
    vi.mocked(openDialog).mockResolvedValue('/work/after');
    vi.mocked(invoke).mockResolvedValue(true);

    expect(await relinkProject(id)).toBe(true);

    expect(blockEditIn('/work/before', 'spec.md')).toBeNull();
  });

  it('forgets the block edits of a document project removed beside a code project', () => {
    addProject('app', '/work/repo', true);
    const docs = addDocumentProject('spec', '/work/repo', 'spec.md');
    startBlockEdit({
      projectRoot: '/work/repo',
      documentPath: 'spec.md',
      source: 'Text.\n',
      block: { index: 0, raw: 'Text.\n' } as DocumentBlock,
    });

    removeProject(docs);

    // A code project never shows them; only a document project could.
    expect(blockEditIn('/work/repo', 'spec.md')).toBeNull();
  });

  it('keeps the block edits of a path another project still opens', () => {
    const code = addProject('app', '/work/shared', true);
    addDocumentProject('spec', '/work/shared', 'spec.md');
    startBlockEdit({
      projectRoot: '/work/shared',
      documentPath: 'spec.md',
      source: 'Text.\n',
      block: { index: 0, raw: 'Text.\n' } as DocumentBlock,
    });

    removeProject(code);

    expect(blockEditIn('/work/shared', 'spec.md')).not.toBeNull();
  });
});

describe('project order', () => {
  afterEach(() => {
    setStore({ projects: [] });
  });

  const names = () => store.projects.map((p) => p.name);

  it('keeps projects sorted by name, ignoring case, when added or renamed', () => {
    addProject('zeta', '/z');
    const beta = addProject('Beta', '/b');
    addProject('alpha', '/a');
    addProject('project10', '/p10');
    addProject('project9', '/p9');
    expect(names()).toEqual(['alpha', 'Beta', 'project9', 'project10', 'zeta']);

    updateProject(beta, { name: 'omega' });
    expect(names()).toEqual(['alpha', 'omega', 'project9', 'project10', 'zeta']);
  });
});
