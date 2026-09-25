import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createWorktree: vi.fn() }));

vi.mock('./git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./git.js')>()),
  createWorktree: mocks.createWorktree,
}));
vi.mock('./pty.js', () => ({ killAgent: vi.fn(), notifyAgentListChanged: vi.fn() }));
vi.mock('./plans.js', () => ({ stopPlanWatcher: vi.fn() }));
vi.mock('./steps.js', () => ({ stopStepsWatcher: vi.fn() }));

import { createTask } from './tasks.js';
import { reconcileWorktreeIntents } from './worktree-intents.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('createTask', () => {
  it('journals the worktree before provisioning it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-tasks-'));
    tempDirs.push(root);
    const journal = path.join(root, 'worktree-intents.json');
    const projectRoot = path.join(root, 'repo');
    reconcileWorktreeIntents(journal, null);

    let journaledAtProvision: unknown[] = [];
    mocks.createWorktree.mockImplementation(async (repoRoot: string, branch: string) => {
      journaledAtProvision = JSON.parse(fs.readFileSync(journal, 'utf8')).intents;
      return { path: `${repoRoot}/.worktrees/${branch}`, branch };
    });

    const task = await createTask('Fix login', projectRoot, [], 'task');

    expect(journaledAtProvision).toEqual([
      expect.objectContaining({
        worktreePath: task.worktree_path,
        branchName: task.branch_name,
        projectRoot,
      }),
    ]);
  });
});
