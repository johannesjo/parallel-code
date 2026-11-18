import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  finishSessionRecording,
  recordSessionHook,
  recordSessionInput,
  recordSessionOutput,
  startSessionRecording,
} from './session-recorder.js';

describe('session recorder', () => {
  let dir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-19T10:00:00Z'));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-session-recorder-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function savedFiles(): string[] {
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  }

  it('writes what the launch printed, was typed and reported, with the gaps between', () => {
    startSessionRecording('launch-abcdef123', '/usr/local/bin/claude', {
      PARALLEL_CODE_RECORD_SESSIONS: dir,
    });
    recordSessionOutput('launch-abcdef123', '❯ ');
    vi.advanceTimersByTime(1500);
    recordSessionInput('launch-abcdef123', 'hi\r');
    recordSessionHook('launch-abcdef123', 'claude', { hook_event_name: 'UserPromptSubmit' });
    vi.advanceTimersByTime(5);
    recordSessionOutput('launch-abcdef123', 'working');
    // Hooks of launches that are not recorded are ignored.
    recordSessionHook('launch-other', 'claude', { hook_event_name: 'Stop' });
    // Quiet time before exit still counts: timers that settle a status run in it.
    vi.advanceTimersByTime(5000);
    finishSessionRecording('launch-abcdef123');

    expect(savedFiles()).toEqual(['claude-2026-11-19T10-00-00-000Z-launch-a.json']);
    const session = JSON.parse(fs.readFileSync(path.join(dir, savedFiles()[0] ?? ''), 'utf8'));
    expect(session).toMatchObject({ command: 'claude', hooks: 'claude', version: 'unknown' });
    expect(session.steps).toEqual([
      { output: '❯ ' },
      { wait: 1500 },
      { input: 'hi\r' },
      { hook: { hook_event_name: 'UserPromptSubmit' } },
      { output: 'working' },
      { wait: 5000 },
    ]);
  });

  it('stops at 8 MB and says so, without a trailing wait past the cut', () => {
    startSessionRecording('launch-big', 'codex', { PARALLEL_CODE_RECORD_SESSIONS: dir });
    recordSessionOutput('launch-big', 'x'.repeat(8 * 1024 * 1024 + 1));
    vi.advanceTimersByTime(100);
    recordSessionOutput('launch-big', 'dropped');
    vi.advanceTimersByTime(5000);
    finishSessionRecording('launch-big');

    const session = JSON.parse(fs.readFileSync(path.join(dir, savedFiles()[0] ?? ''), 'utf8'));
    expect(session.steps).toHaveLength(1);
    expect(session.recorded).toContain('everything past 8 MB was dropped');
  });

  it('records nothing unless the variable names an absolute directory', () => {
    startSessionRecording('launch-1', 'claude', {});
    startSessionRecording('launch-2', 'claude', { PARALLEL_CODE_RECORD_SESSIONS: 'relative/dir' });
    recordSessionOutput('launch-1', 'x');
    recordSessionOutput('launch-2', 'x');
    finishSessionRecording('launch-1');
    finishSessionRecording('launch-2');

    expect(savedFiles()).toEqual([]);
    expect(fs.existsSync(path.resolve('relative/dir'))).toBe(false);
  });
});
