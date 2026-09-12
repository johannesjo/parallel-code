import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { injectSubTaskPreamble, restoreSubTaskPreambleInjection } from './preamble.js';

describe('sub-task preamble injection', () => {
  it('appends to AGENTS.md for Codex-style agents and can restore the original content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parallel-code-preamble-test-'));
    const agentsPath = join(dir, 'AGENTS.md');
    writeFileSync(agentsPath, 'existing instructions');
    const queue = new Map<string, Promise<void>>();

    try {
      const injected = await injectSubTaskPreamble({
        worktreePath: dir,
        agentCommand: 'codex',
        queue,
      });

      expect(injected).toMatchObject({
        filePath: agentsPath,
        existedBefore: true,
        restoreOnFailure: true,
      });
      expect(readFileSync(agentsPath, 'utf8')).toContain('existing instructions');
      expect(readFileSync(agentsPath, 'utf8')).toContain('<sub-task-mode>');

      await restoreSubTaskPreambleInjection(injected);

      expect(readFileSync(agentsPath, 'utf8')).toBe('existing instructions');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes Kimi child preambles to AGENTS.md instead of Claude settings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parallel-code-preamble-test-'));
    const agentsPath = join(dir, 'AGENTS.md');
    const settingsPath = join(dir, '.claude', 'settings.local.json');
    const queue = new Map<string, Promise<void>>();

    try {
      const injected = await injectSubTaskPreamble({
        worktreePath: dir,
        agentCommand: 'kimi',
        queue,
      });

      expect(injected).toMatchObject({
        filePath: agentsPath,
        existedBefore: false,
        restoreOnFailure: true,
      });
      expect(readFileSync(agentsPath, 'utf8')).toContain('<sub-task-mode>');
      expect(existsSync(settingsPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes Claude settings.local.json without making it a failure-restore target', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parallel-code-preamble-test-'));
    const settingsPath = join(dir, '.claude', 'settings.local.json');
    const queue = new Map<string, Promise<void>>();

    try {
      const injected = await injectSubTaskPreamble({
        worktreePath: dir,
        agentCommand: 'claude',
        queue,
      });

      expect(injected).toMatchObject({
        filePath: settingsPath,
        existedBefore: false,
        restoreOnFailure: false,
      });
      expect(JSON.parse(readFileSync(settingsPath, 'utf8')).systemPrompt).toContain(
        '<sub-task-mode>',
      );

      await restoreSubTaskPreambleInjection(injected);

      expect(existsSync(settingsPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports existing Claude settings content when appending the system prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parallel-code-preamble-test-'));
    const settingsDir = join(dir, '.claude');
    const settingsPath = join(settingsDir, 'settings.local.json');
    const originalContent = JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }, null, 2);
    const queue = new Map<string, Promise<void>>();
    mkdirSync(settingsDir);
    writeFileSync(settingsPath, originalContent);

    try {
      const injected = await injectSubTaskPreamble({
        worktreePath: dir,
        agentCommand: 'claude',
        queue,
      });

      expect(injected).toMatchObject({
        filePath: settingsPath,
        originalContent,
        existedBefore: true,
        restoreOnFailure: false,
      });
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        permissions?: { allow?: string[] };
        systemPrompt?: string;
      };
      expect(settings.permissions?.allow).toEqual(['Bash(npm test)']);
      expect(settings.systemPrompt).toContain('<sub-task-mode>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
