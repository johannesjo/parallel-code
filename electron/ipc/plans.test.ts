import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';
import { readPlanForWorktree, startPlanWatcher, stopAllPlanWatchers } from './plans.js';

let worktreePath: string;

beforeEach(() => {
  worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-detection-'));
  git('init', '--quiet');
});

afterEach(() => {
  stopAllPlanWatchers();
  fs.rmSync(worktreePath, { recursive: true, force: true });
});

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: worktreePath, stdio: 'pipe' });
}

function commitFiles(): void {
  git('add', '.');
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--quiet',
    '-m',
    'Initial files',
  );
}

function writeFile(relativePath: string, content = '# Theme plan'): void {
  const filePath = path.join(worktreePath, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function watchPlans() {
  const send = vi.fn();
  const win = { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow;
  startPlanWatcher(win, 'task-1', worktreePath);
  return send;
}

describe('root-level plan files', () => {
  it.each(['example-plan.md', 'PLAN.md', 'implementation_plan.md', 'plan.v2.md'])(
    'reads %s for plan review and restores it by filename',
    (fileName) => {
      writeFile(fileName);
      const expected = { content: '# Theme plan', fileName, relativePath: fileName };
      expect(readPlanForWorktree(worktreePath)).toEqual(expected);
      expect(readPlanForWorktree(worktreePath, fileName)).toEqual(expected);
    },
  );

  it('does not treat unrelated root Markdown files as plans', () => {
    for (const file of ['README.md', 'AGENTS.md', 'explanation.md', 'planet.md']) writeFile(file);
    expect(readPlanForWorktree(worktreePath)).toBeNull();
    expect(readPlanForWorktree(worktreePath, 'README.md')).toBeNull();
  });

  it('compares root plans with the existing plan directories by modification time', () => {
    writeFile('.claude/plans/random-name.md', '# Old plan');
    fs.utimesSync(path.join(worktreePath, '.claude/plans/random-name.md'), 1, 1);
    writeFile('example-plan.md');
    expect(readPlanForWorktree(worktreePath)?.relativePath).toBe('example-plan.md');
    expect(readPlanForWorktree(worktreePath, 'random-name.md')?.content).toBe('# Old plan');
  });

  it('publishes a root plan when it is created, edited, and removed', async () => {
    const send = watchPlans();
    writeFile('example-plan.md');
    await vi.waitFor(() =>
      expect(send).toHaveBeenLastCalledWith(IPC.PlanContent, {
        taskId: 'task-1',
        content: '# Theme plan',
        fileName: 'example-plan.md',
        relativePath: 'example-plan.md',
      }),
    );
    writeFile('example-plan.md', '# Updated plan');
    await vi.waitFor(() =>
      expect(send).toHaveBeenLastCalledWith(
        IPC.PlanContent,
        expect.objectContaining({ content: '# Updated plan' }),
      ),
    );
    fs.unlinkSync(path.join(worktreePath, 'example-plan.md'));
    await vi.waitFor(() =>
      expect(send).toHaveBeenLastCalledWith(IPC.PlanContent, {
        taskId: 'task-1',
        content: null,
        fileName: null,
        relativePath: null,
      }),
    );
  });

  it('does not publish inherited plans on startup or unrelated root changes', async () => {
    writeFile('example-plan.md', '# Inherited plan');
    commitFiles();
    const send = watchPlans();
    writeFile('README.md');
    writeFile('package.json', '{}');
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['example-plan.md', '.claude/plans/random-name.md', 'docs/plans/design.md'])(
    'discovers an existing uncommitted plan at startup: %s',
    async (relativePath) => {
      writeFile('.gitignore', '.claude/\n');
      writeFile(relativePath);
      const send = watchPlans();
      await vi.waitFor(() =>
        expect(send).toHaveBeenLastCalledWith(
          IPC.PlanContent,
          expect.objectContaining({ relativePath, content: '# Theme plan' }),
        ),
      );
    },
  );

  it('recovers a changed tracked plan while ignoring a newer inherited plan', async () => {
    writeFile('example-plan.md', '# Original');
    writeFile('docs/plans/inherited.md', '# Inherited');
    commitFiles();
    writeFile('example-plan.md', '# Task changes');
    fs.utimesSync(path.join(worktreePath, 'example-plan.md'), 1, 1);
    const send = watchPlans();
    await vi.waitFor(() =>
      expect(send).toHaveBeenLastCalledWith(
        IPC.PlanContent,
        expect.objectContaining({ relativePath: 'example-plan.md', content: '# Task changes' }),
      ),
    );
  });

  it.each(['.claude/plans/random-name.md', 'docs/plans/design.md'])(
    'still publishes changes in %s',
    async (relativePath) => {
      fs.mkdirSync(path.dirname(path.join(worktreePath, relativePath)), { recursive: true });
      const send = watchPlans();
      writeFile(relativePath);
      await vi.waitFor(() =>
        expect(send).toHaveBeenLastCalledWith(
          IPC.PlanContent,
          expect.objectContaining({ relativePath, content: '# Theme plan' }),
        ),
      );
    },
  );
});
