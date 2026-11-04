import { mkdtempSync, rmSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { findTagged, RUN_TAG_ENV, signalTagged } from './process-tag.js';
import { freePorts, startServer } from './task-screens-serve.js';

// Real processes and ports, so spawning, waiting and log reading behave as in the app.
let dir: string;
const tag = `serve-test-${process.pid}`;
const env = { ...(process.env as Record<string, string>), [RUN_TAG_ENV]: tag };
const SERVER = `exec node -e "require('http').createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT))"`;

const serve = async (command: string, timeoutMs = 10_000, cancelled = () => false) =>
  startServer(
    {
      cwd: dir,
      command,
      env,
      port: (await freePorts(1))[0],
      logFile: join(dir, 'server.log'),
      cancelled,
    },
    timeoutMs,
  );

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pc-serve-'));
});

afterEach(() => signalTagged(tag, 'SIGKILL'));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('freePorts', () => {
  it('returns distinct ports that can be listened on', async () => {
    const ports = await freePorts(2);
    expect(new Set(ports).size).toBe(2);
    for (const port of ports) {
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(port, resolve));
      server.close();
    }
  });
});

describe('startServer', () => {
  it('starts the command on the port, with the run tag, and resolves once it answers', async () => {
    await expect(serve(SERVER)).resolves.toBeUndefined();
    expect(findTagged(tag).length).toBeGreaterThan(0);
  });

  it('fails at once with the end of the log when the command exits', async () => {
    await expect(serve('echo "Cannot find module vite" >&2; exit 1')).rejects.toThrow(
      'Cannot find module vite',
    );
  });

  it('stops waiting once the capture is cancelled', async () => {
    // A launcher that exits 0 is waited on, so only the cancel ends the wait early.
    const started = Date.now();
    let cancelled = false;
    setTimeout(() => (cancelled = true), 300);
    await expect(serve('exit 0', 10_000, () => cancelled)).rejects.toThrow('cancelled');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('fails when nothing answers in time', async () => {
    await expect(serve('exec sleep 30', 500)).rejects.toThrow('did not answer');
  });
});
