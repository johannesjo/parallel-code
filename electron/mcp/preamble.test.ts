import { describe, expect, it } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  injectSubTaskPreamble,
  removePreambleBlock,
  restoreSubTaskPreambleInjection,
  stripPreambleFromBranch,
  SUB_TASK_MODE_PREAMBLE,
} from './preamble.js';

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

  it.each(['kimi', '/usr/local/bin/kimi'])(
    'writes %s child preambles to AGENTS.md instead of Claude settings',
    async (agentCommand) => {
      const dir = mkdtempSync(join(tmpdir(), 'parallel-code-preamble-test-'));
      const agentsPath = join(dir, 'AGENTS.md');
      const settingsPath = join(dir, '.claude', 'settings.local.json');
      const queue = new Map<string, Promise<void>>();

      try {
        const injected = await injectSubTaskPreamble({
          worktreePath: dir,
          agentCommand,
          queue,
        });

        expect(injected).toMatchObject({
          filePath: agentsPath,
          existedBefore: false,
          restoreOnFailure: true,
        });
        expect(readFileSync(agentsPath, 'utf8')).toContain('<sub-task-mode>');
        expect(existsSync(settingsPath)).toBe(false);
        await restoreSubTaskPreambleInjection(injected);
        expect(existsSync(agentsPath)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(['kimi-helper', '/opt/kimi/bin/claude', 'KIMI'])(
    'does not classify %s as the Kimi executable',
    async (agentCommand) => {
      const dir = mkdtempSync(join(tmpdir(), 'parallel-code-preamble-test-'));
      try {
        const injected = await injectSubTaskPreamble({
          worktreePath: dir,
          agentCommand,
          queue: new Map(),
        });
        expect(injected.filePath).toBeUndefined();
        expect(existsSync(join(dir, '.claude', 'settings.local.json'))).toBe(false);
        expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('writes nothing for Claude, leaving existing settings untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parallel-code-preamble-test-'));
    const settingsPath = join(dir, '.claude', 'settings.local.json');
    try {
      const injected = await injectSubTaskPreamble({
        worktreePath: dir,
        agentCommand: '/home/codex/bin/claude',
        queue: new Map(),
      });
      expect(injected).toEqual({
        originalContent: null,
        existedBefore: false,
        restoreOnFailure: false,
      });
      expect(existsSync(settingsPath)).toBe(false);
      expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects the agent from the basename, not the directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parallel-code-preamble-test-'));
    try {
      const injected = await injectSubTaskPreamble({
        worktreePath: dir,
        agentCommand: '/opt/gemini-tools/bin/codex',
        queue: new Map(),
      });
      expect(injected.filePath).toBe(join(dir, 'AGENTS.md'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['codex', 'kimi'])(
    'does not follow or replace a symlinked %s instruction file',
    async (agentCommand) => {
      const dir = mkdtempSync(join(tmpdir(), 'parallel-code-preamble-test-'));
      try {
        writeFileSync(join(dir, 'CLAUDE.md'), 'shared rules');
        symlinkSync('CLAUDE.md', join(dir, 'AGENTS.md'));
        const injected = await injectSubTaskPreamble({
          worktreePath: dir,
          agentCommand,
          queue: new Map(),
        });
        expect(injected.filePath).toBeUndefined();
        expect(injected.existedBefore).toBe(true);
        expect(injected.restoreOnFailure).toBe(false);
        expect(lstatSync(join(dir, 'AGENTS.md')).isSymbolicLink()).toBe(true);
        expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('shared rules');
        await stripPreambleFromBranch({ worktreePath: dir, preambleFileExistedBefore: true });
        expect(lstatSync(join(dir, 'AGENTS.md')).isSymbolicLink()).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(['codex', 'kimi'])(
    'does not append a second %s block and keeps CRLF endings',
    async (agentCommand) => {
      const dir = mkdtempSync(join(tmpdir(), 'parallel-code-preamble-test-'));
      const agentsPath = join(dir, 'AGENTS.md');
      try {
        writeFileSync(agentsPath, 'one\r\ntwo\r\n');
        const opts = { worktreePath: dir, agentCommand, queue: new Map() };
        await injectSubTaskPreamble(opts);
        const once = readFileSync(agentsPath, 'utf8');
        expect(once).toContain(SUB_TASK_MODE_PREAMBLE.replace(/\n/g, '\r\n'));
        expect(once.replace(/\r\n/g, '')).not.toContain('\n');
        await injectSubTaskPreamble(opts);
        expect(readFileSync(agentsPath, 'utf8')).toBe(once);
        await stripPreambleFromBranch({ worktreePath: dir, preambleFileExistedBefore: true });
        expect(readFileSync(agentsPath, 'utf8')).toBe('one\r\ntwo\r\n');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('restore removes a file it created and tolerates it being gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parallel-code-preamble-test-'));
    try {
      const injected = await injectSubTaskPreamble({
        worktreePath: dir,
        agentCommand: 'codex',
        queue: new Map(),
      });
      await restoreSubTaskPreambleInjection(injected);
      expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
      await expect(restoreSubTaskPreambleInjection(injected)).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never clobbers a malformed legacy settings.local.json when stripping', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parallel-code-preamble-test-'));
    const settingsPath = join(dir, '.claude', 'settings.local.json');
    try {
      mkdirSync(join(dir, '.claude'));
      writeFileSync(settingsPath, '{ not json');
      await stripPreambleFromBranch({ worktreePath: dir });
      expect(readFileSync(settingsPath, 'utf8')).toBe('{ not json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strips the legacy systemPrompt but keeps other settings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parallel-code-preamble-test-'));
    const settingsPath = join(dir, '.claude', 'settings.local.json');
    try {
      mkdirSync(join(dir, '.claude'));
      const systemPrompt = `${SUB_TASK_MODE_PREAMBLE}`;
      writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['x'] }, systemPrompt }));
      await stripPreambleFromBranch({ worktreePath: dir });
      expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
        permissions: { allow: ['x'] },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('removePreambleBlock', () => {
  const block = SUB_TASK_MODE_PREAMBLE;

  it('removes every complete block and keeps surrounding content', () => {
    expect(removePreambleBlock(`a\n\n${block}\n\nb\n\n${block}`)).toBe('a\n\nb');
  });

  it('ignores the tag when it is not on its own line', () => {
    const prose = 'Docs mention <sub-task-mode> inline.\nMore text';
    expect(removePreambleBlock(prose)).toBe(prose);
  });

  it('drops to EOF only for an unclosed start tag on its own line', () => {
    expect(removePreambleBlock('keep\n\n<sub-task-mode>\ntruncated')).toBe('keep');
  });
});
