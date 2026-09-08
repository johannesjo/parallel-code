import { describe, expect, it } from 'vitest';
import { buildEndpointFile, buildHookScript } from './hook-script.js';

describe('buildHookScript', () => {
  const script = buildHookScript();
  const lines = script.split('\n');

  it('answers Claude before doing anything that could fail', () => {
    const firstCommand = lines.find((line) => line.length > 0 && !line.startsWith('#'));
    expect(firstCommand).toBe("printf '{}\\n'");
  });

  it('drains stdin before any early exit so the agent never sees EPIPE', () => {
    const readIndex = lines.findIndex((line) => line.startsWith('payload=$('));
    const firstExit = lines.findIndex((line) => line.includes('exit 0'));
    expect(readIndex).toBeGreaterThan(-1);
    expect(firstExit).toBeGreaterThan(readIndex);
  });

  it('re-sources the endpoint file on every run and posts with the token header', () => {
    expect(script).toContain('. "$PARALLEL_CODE_HOOK_ENDPOINT"');
    expect(script).toContain('http://127.0.0.1:$PARALLEL_CODE_HOOK_PORT/hook/claude');
    expect(script).toContain('x-parallel-code-hook-token: $PARALLEL_CODE_HOOK_TOKEN');
    expect(script).toContain('x-parallel-code-agent-id: $PARALLEL_CODE_AGENT_ID');
  });

  it('stays quiet for background job workers that inherited the env', () => {
    expect(script).toContain('CLAUDE_JOB_DIR');
  });

  it('never fails the hook, even when curl does', () => {
    expect(script).toContain('|| :');
    expect(script.trimEnd().endsWith('exit 0')).toBe(true);
  });
});

describe('buildEndpointFile', () => {
  it('is sourceable shell with one assignment per line', () => {
    expect(buildEndpointFile(4321, 'tok')).toBe(
      'PARALLEL_CODE_HOOK_PORT=4321\nPARALLEL_CODE_HOOK_TOKEN=tok\n',
    );
  });
});
