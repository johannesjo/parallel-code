/* global process */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pinModelArgs } from './pinned-agent.mjs';

describe('pinModelArgs', () => {
  it('pins Claude Code to Haiku, whatever model the app asks for', () => {
    expect(
      pinModelArgs('claude', [
        '--model',
        'opus',
        '--fallback-model=sonnet',
        '--continue',
        '--model=claude-opus-4-1',
      ]),
    ).toEqual(['--model', 'haiku', '--continue']);
  });

  it('pins Codex to gpt-6-luna and drops profiles that could name a model', () => {
    expect(
      pinModelArgs('codex', [
        'exec',
        '-m',
        'gpt-6-sol',
        '-mgpt-5.5',
        '--model=gpt-6-astra',
        '-c',
        'model="gpt-6-sol"',
        '--config=profile=big',
        '-p',
        'big',
        '-c',
        'model_reasoning_effort="low"',
        '--json',
      ]),
    ).toEqual(['-c', 'model="gpt-6-luna"', 'exec', '-c', 'model_reasoning_effort="low"', '--json']);
  });

  it('keeps resume arguments and prompt text after --', () => {
    expect(pinModelArgs('codex', ['resume', '--last', '--', '-m', 'as text'])).toEqual([
      '-c',
      'model="gpt-6-luna"',
      'resume',
      '--last',
      '--',
      '-m',
      'as text',
    ]);
  });

  it('refuses Codex servers, which choose the model per request', () => {
    expect(() => pinModelArgs('codex', ['app-server'])).toThrow(/cannot pin the model/);
    expect(() => pinModelArgs('codex', ['mcp-server'])).toThrow(/cannot pin the model/);
  });

  it('refuses agents without a pinned model', () => {
    expect(() => pinModelArgs('gemini', [])).toThrow(/No pinned model/);
  });

  it('runs the real binary with the pinned arguments and model environment', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-agent-'));
    try {
      const fakeClaude = path.join(dir, 'claude');
      fs.writeFileSync(fakeClaude, '#!/bin/sh\necho "$* | $CLAUDE_CODE_SUBAGENT_MODEL"\nexit 3\n', {
        mode: 0o755,
      });
      const script = path.join(import.meta.dirname, 'pinned-agent.mjs');
      const run = () =>
        execFileSync(process.execPath, [script, 'claude', fakeClaude, '--model', 'opus', '-p'], {
          encoding: 'utf8',
        });
      expect(run).toThrow(
        expect.objectContaining({
          status: 3,
          stdout: '--model haiku -p | claude-haiku-4-5-20251001\n',
        }),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
