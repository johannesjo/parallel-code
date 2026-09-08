import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  classifyEslintError,
  isLintablePath,
  loadEslintQualityFindings,
  parseEslintFindings,
} from './eslint-quality-findings.js';

describe('ESLint quality findings', () => {
  it('parses only changed lintable files and maps rule messages', () => {
    const worktreePath = '/tmp/project';
    const stdout = JSON.stringify([
      {
        filePath: '/tmp/project/src/a.ts',
        messages: [
          {
            ruleId: '@typescript-eslint/no-explicit-any',
            severity: 2,
            message: 'Unexpected any.',
            line: 4,
            column: 7,
            endLine: 4,
            endColumn: 10,
          },
          { ruleId: null, severity: 2, message: 'Parsing error', line: 1, column: 1 },
        ],
      },
      {
        filePath: '/tmp/project/README.md',
        messages: [{ ruleId: 'markdown/rule', severity: 2, message: 'ignored', line: 1 }],
      },
    ]);

    expect(parseEslintFindings(stdout, worktreePath, ['src/a.ts', 'README.md'])).toEqual([
      {
        id: 'eslint:src/a.ts:4:7:@typescript-eslint/no-explicit-any',
        source: 'eslint',
        ruleId: '@typescript-eslint/no-explicit-any',
        category: 'maintainability',
        severity: 'error',
        location: {
          filePath: 'src/a.ts',
          startLine: 4,
          startColumn: 7,
          endLine: 4,
          endColumn: 10,
        },
        explanation: 'Unexpected any.',
      },
    ]);
  });

  it('recognizes supported JavaScript and TypeScript paths', () => {
    expect(isLintablePath('src/a.ts')).toBe(true);
    expect(isLintablePath('src/a.tsx')).toBe(true);
    expect(isLintablePath('src/a.js')).toBe(true);
    expect(isLintablePath('README.md')).toBe(false);
  });

  it('silently skips projects without an ESLint config', async () => {
    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-eslint-'));
    try {
      await expect(loadEslintQualityFindings(worktreePath, ['src/a.ts'])).resolves.toEqual({
        status: 'not-applicable',
      });
    } finally {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it('silently skips legacy ESLint configs that ESLint 9 does not load', async () => {
    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-eslint-'));
    try {
      fs.writeFileSync(path.join(worktreePath, '.eslintrc.json'), '{}');
      await expect(loadEslintQualityFindings(worktreePath, ['src/a.ts'])).resolves.toEqual({
        status: 'not-applicable',
      });
    } finally {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it('silently skips configured projects without a local ESLint binary', async () => {
    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-eslint-'));
    try {
      fs.writeFileSync(path.join(worktreePath, 'eslint.config.js'), 'export default [];');
      await expect(loadEslintQualityFindings(worktreePath, ['src/a.ts'])).resolves.toEqual({
        status: 'not-applicable',
      });
    } finally {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it('runs the local binary with a path separator and parses its output', async () => {
    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-eslint-'));
    try {
      const binaryPath = path.join(worktreePath, 'node_modules', '.bin');
      fs.mkdirSync(binaryPath, { recursive: true });
      fs.writeFileSync(path.join(worktreePath, 'eslint.config.js'), 'export default [];');
      fs.writeFileSync(path.join(binaryPath, 'eslint'), '');
      const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
      const execImpl = async (
        file: string,
        args: string[],
        options: { cwd: string; timeout: number; maxBuffer: number },
      ) => {
        calls.push({ file, args, cwd: options.cwd });
        return {
          stdout: JSON.stringify([
            {
              filePath: path.join(worktreePath, 'src/a.ts'),
              messages: [
                {
                  ruleId: 'no-console',
                  severity: 1,
                  message: 'Unexpected console statement.',
                  line: 2,
                },
              ],
            },
          ]),
          stderr: '',
        };
      };

      await expect(
        loadEslintQualityFindings(worktreePath, ['src/a.ts'], execImpl),
      ).resolves.toEqual({
        status: 'available',
        findings: [
          expect.objectContaining({
            ruleId: 'no-console',
            severity: 'warning',
          }),
        ],
      });
      expect(calls).toEqual([
        expect.objectContaining({
          file: path.join(worktreePath, 'node_modules', '.bin', 'eslint'),
          args: ['--format', 'json', '--no-error-on-unmatched-pattern', '--', 'src/a.ts'],
          cwd: worktreePath,
        }),
      ]);
    } finally {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it('maps missing executable and unsupported flat-config errors to not-applicable', () => {
    expect(classifyEslintError({ code: 'ENOENT' })).toEqual({ status: 'not-applicable' });
    expect(
      classifyEslintError({ stderr: "ESLint couldn't find an eslint.config.(js|mjs|cjs) file." }),
    ).toEqual({ status: 'not-applicable' });
  });
});
