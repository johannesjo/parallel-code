import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCardCheck, type CardCheckRequest } from './card-check.js';
import { createVerificationRunner } from './verify.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function worktree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-check-test-'));
  dirs.push(dir);
  return dir;
}

function request(command: string, extra: Partial<CardCheckRequest> = {}): CardCheckRequest {
  return {
    key: 't1:card:todos',
    worktreePath: worktree(),
    command,
    mode: 'json',
    env: {},
    diff: 'diff --git a/x b/x\n+new\n',
    ...extra,
  };
}

const runner = createVerificationRunner({ shell: '/bin/sh' });

describe('runCardCheck', () => {
  it('reads the JSON a check writes to PC_OUT_FILE, past noisy output', async () => {
    const result = await runCardCheck(
      runner,
      request(
        `echo "warning: noise" >&2; echo '{"oops":' ; printf '{"count":{"value":3}}' > "$PC_OUT_FILE"`,
      ),
    );
    expect(result.run.status).toBe('passed');
    expect(result.output).toEqual({ count: { value: 3 } });
    expect(result.error).toBeUndefined();
  });

  it('hands the check its context as files, and deletes them after the run', async () => {
    const result = await runCardCheck(
      runner,
      request(
        `cat "$PC_DIFF_FILE"; cat "$PC_PREVIOUS_FILE"; echo "$PC_TASK_NAME|$PC_BASE_BRANCH"; echo "dir=$(dirname "$PC_OUT_FILE")"`,
        {
          mode: 'exit-code',
          previous: '{"count":{"value":2}}',
          env: { PC_TASK_NAME: 'Fix login', PC_BASE_BRANCH: 'main' },
        },
      ),
    );
    expect(result.run.outputTail).toContain('+new');
    expect(result.run.outputTail).toContain('{"count":{"value":2}}');
    expect(result.run.outputTail).toContain('Fix login|main');
    const dir = /dir=(.+)/.exec(result.run.outputTail)?.[1] ?? '';
    expect(dir.startsWith(os.tmpdir())).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('fails a JSON run whose file is missing, invalid or too large', async () => {
    const missing = await runCardCheck(runner, request('true'));
    expect(missing.error).toBe('PC_OUT_FILE missing');
    const invalid = await runCardCheck(runner, request(`echo '[1]' > "$PC_OUT_FILE"`));
    expect(invalid.error).toBe('PC_OUT_FILE must hold one JSON object');
    const big = await runCardCheck(
      runner,
      request(`head -c 70000 /dev/zero | tr '\\0' ' ' > "$PC_OUT_FILE"`),
    );
    expect(big.error).toBe('PC_OUT_FILE is larger than 64 KB');
    expect(big.output).toBeUndefined();
  });

  it('reads no file after a failed run, and none in exit-code mode', async () => {
    const failed = await runCardCheck(runner, request(`echo '{}' > "$PC_OUT_FILE"; exit 3`));
    expect(failed.run.exitCode).toBe(3);
    expect(failed.output).toBeUndefined();
    expect(failed.error).toBeUndefined();
    const plain = await runCardCheck(runner, request('true', { mode: 'exit-code' }));
    expect(plain.run.status).toBe('passed');
    expect(plain.error).toBeUndefined();
  });
});
