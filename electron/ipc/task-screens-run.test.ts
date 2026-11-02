import { spawn } from 'child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { killAllCaptures, startCapture } from './task-screens-run.js';

// A fake `claude` on PATH; real processes, so pipes and process groups behave as in the app.
let bin: string;
const originalPath = process.env.PATH;

function fakeClaude(script: string): void {
  const file = join(bin, 'claude');
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
}

const steps: string[] = [];
const start = () =>
  startCapture({
    cwd: bin,
    addDirs: [],
    prompt: 'go',
    systemPrompt: 'sys',
    onStep: (step) => steps.push(step),
  });
const run = () => start().result;

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: the process is gone.
    return false;
  }
};

// What `claude -p --output-format stream-json` prints: one event per line.
const RESULT = `echo '{"type":"result","is_error":false,"result":"{\\"shots\\":[]}"}'`;
const TOOL_CALL = `echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm run dev &","description":"Start the dev server"}}]}}'`;

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), 'pc-fake-claude-'));
  process.env.PATH = `${bin}:${originalPath}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
  rmSync(bin, { recursive: true, force: true });
});

describe('startCapture', () => {
  it('returns the answer and reports each step as it happens', async () => {
    steps.length = 0;
    fakeClaude(`cat >/dev/null; ${TOOL_CALL}; ${RESULT}`);
    await expect(run()).resolves.toBe('{"shots":[]}');
    expect(steps).toEqual(['Start the dev server']);
  });

  it('fails when the CLI ends without an answer', async () => {
    fakeClaude(`cat >/dev/null; ${TOOL_CALL}`);
    await expect(run()).rejects.toThrow('Claude ended without an answer.');
  });

  it('finishes when a server left behind in its own session still holds the output', async () => {
    // A dev server started with setsid escapes the group kill and keeps stdout open.
    // The pause lets setsid leave the group before the CLI exits, as a real server would have.
    fakeClaude(`cat >/dev/null; setsid sleep 3 & sleep 0.3; ${RESULT}`);
    const capture = start();
    await expect(capture.result).resolves.toBe('{"shots":[]}');
    capture.end();
  }, 5_000);

  it('reports a failed CLI with its error output', async () => {
    fakeClaude('cat >/dev/null; echo "not logged in" >&2; exit 1');
    await expect(run()).rejects.toThrow('not logged in');
  });

  it('can be cancelled while a server in its own session holds the output', async () => {
    fakeClaude('cat >/dev/null; setsid sleep 3 & sleep 30');
    const capture = start();
    setTimeout(() => capture.stop('cancelled'), 300);
    await expect(capture.result).rejects.toThrow('cancelled');
  }, 5_000);

  it('keeps servers up after the answer, and stops even those that left its group on end', async () => {
    const pidFile = join(bin, 'server.pid');
    // setsid takes the server out of the CLI's process group; only the tag still finds it.
    fakeClaude(
      `cat >/dev/null; setsid sh -c 'echo $$ > ${pidFile}; exec sleep 30' >/dev/null & sleep 0.3; ${RESULT}`,
    );
    const capture = start();
    await capture.result;
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(isAlive(pid)).toBe(true);
    capture.end();
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false));
  });

  it('stops on end a server the app started with the run’s environment', async () => {
    fakeClaude(`cat >/dev/null; ${RESULT}`);
    const capture = start();
    await capture.result;
    const server = spawn('sleep', ['30'], { env: capture.env, detached: true, stdio: 'ignore' });
    expect(isAlive(server.pid ?? 0)).toBe(true);
    capture.end();
    await vi.waitFor(() => expect(server.exitCode ?? server.signalCode).toBeTruthy());
  });

  it('kills the servers of every run when the app quits', async () => {
    const pidFile = join(bin, 'quit.pid');
    fakeClaude(
      `cat >/dev/null; setsid sh -c 'echo $$ > ${pidFile}; exec sleep 30' >/dev/null & sleep 0.3; ${RESULT}`,
    );
    await run();
    const pid = Number(readFileSync(pidFile, 'utf8'));
    killAllCaptures();
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false));
  });

  it('keeps a delivered answer when the CLI fails while shutting down', async () => {
    fakeClaude(`cat >/dev/null; ${RESULT}; exit 3`);
    await expect(run()).resolves.toBe('{"shots":[]}');
  });

  it('keeps a character that arrives split across two reads', async () => {
    // "Ü" is two bytes in UTF-8; the pause makes them separate reads.
    fakeClaude(
      `cat >/dev/null; printf '{"type":"result","is_error":false,"result":"\\303'; sleep 0.2; printf '\\234bersicht"}\\n'`,
    );
    await expect(run()).resolves.toBe('Übersicht');
  });
});
