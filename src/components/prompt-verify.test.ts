import { describe, expect, it, vi, afterEach } from 'vitest';
import { pollUntilPromptAppearsInOutput } from './prompt-verify';

function makeSignal(aborted = false): AbortSignal {
  const ctrl = new AbortController();
  if (aborted) ctrl.abort();
  return ctrl.signal;
}

describe('pollUntilPromptAppearsInOutput', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Immediate-return paths ---

  it('returns true immediately when prompt is empty', async () => {
    const getTail = vi.fn().mockReturnValue('');
    const result = await pollUntilPromptAppearsInOutput(
      'agent-1',
      '',
      '',
      makeSignal(),
      getTail,
      5_000,
      250,
    );
    expect(result).toBe(true);
    expect(getTail).not.toHaveBeenCalled();
  });

  it('returns true immediately when snippet was already in preSendTail', async () => {
    const getTail = vi.fn().mockReturnValue('');
    const result = await pollUntilPromptAppearsInOutput(
      'agent-1',
      'build the feature',
      'some output build the feature more output',
      makeSignal(),
      getTail,
      5_000,
      250,
    );
    expect(result).toBe(true);
    expect(getTail).not.toHaveBeenCalled();
  });

  it('strips ANSI codes from preSendTail before matching', async () => {
    const getTail = vi.fn().mockReturnValue('');
    const result = await pollUntilPromptAppearsInOutput(
      'agent-1',
      'build feature',
      '\x1b[32mbuild feature\x1b[0m',
      makeSignal(),
      getTail,
      5_000,
      250,
    );
    expect(result).toBe(true);
    expect(getTail).not.toHaveBeenCalled();
  });

  // --- Polling success ---

  it('returns true when snippet appears in tail on first poll', async () => {
    vi.useFakeTimers();
    const getTail = vi.fn().mockReturnValue('build the feature');

    const promise = pollUntilPromptAppearsInOutput(
      'agent-1',
      'build the feature',
      '',
      makeSignal(),
      getTail,
      5_000,
      250,
    );

    await vi.runAllTimersAsync();
    expect(await promise).toBe(true);
  });

  it('returns true when snippet appears after several polls', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const getTail = vi.fn().mockImplementation(() => {
      callCount++;
      return callCount >= 3 ? 'here is the build the feature echo' : 'not yet';
    });

    const promise = pollUntilPromptAppearsInOutput(
      'agent-1',
      'build the feature',
      '',
      makeSignal(),
      getTail,
      5_000,
      250,
    );

    await vi.runAllTimersAsync();
    expect(await promise).toBe(true);
    expect(getTail).toHaveBeenCalledTimes(3);
  });

  it('strips ANSI codes from getTail output before matching', async () => {
    vi.useFakeTimers();
    const getTail = vi.fn().mockReturnValue('\x1b[32mbuild the feature\x1b[0m');

    const promise = pollUntilPromptAppearsInOutput(
      'agent-1',
      'build the feature',
      '',
      makeSignal(),
      getTail,
      5_000,
      250,
    );

    await vi.runAllTimersAsync();
    expect(await promise).toBe(true);
  });

  it('matches only the first 40 characters of the prompt snippet', async () => {
    vi.useFakeTimers();
    const longPrompt = 'a'.repeat(50) + 'should not be matched';
    const snippet = 'a'.repeat(40);
    const getTail = vi.fn().mockReturnValue(snippet);

    const promise = pollUntilPromptAppearsInOutput(
      'agent-1',
      longPrompt,
      '',
      makeSignal(),
      getTail,
      5_000,
      250,
    );

    await vi.runAllTimersAsync();
    expect(await promise).toBe(true);
  });

  // --- Timeout ---

  it('returns false when snippet never appears before deadline', async () => {
    vi.useFakeTimers();
    const getTail = vi.fn().mockReturnValue('unrelated output');

    const promise = pollUntilPromptAppearsInOutput(
      'agent-1',
      'build the feature',
      '',
      makeSignal(),
      getTail,
      500,
      100,
    );

    await vi.runAllTimersAsync();
    expect(await promise).toBe(false);
  });

  it('polls getTail multiple times before giving up', async () => {
    vi.useFakeTimers();
    const getTail = vi.fn().mockReturnValue('unrelated output');

    const promise = pollUntilPromptAppearsInOutput(
      'agent-1',
      'build the feature',
      '',
      makeSignal(),
      getTail,
      1_000,
      250,
    );

    await vi.runAllTimersAsync();
    await promise;
    expect(getTail.mock.calls.length).toBeGreaterThan(1);
  });

  // --- Abort signal ---

  it('returns false immediately when signal is already aborted', async () => {
    vi.useFakeTimers();
    const getTail = vi.fn().mockReturnValue('build the feature');

    const promise = pollUntilPromptAppearsInOutput(
      'agent-1',
      'build the feature',
      '',
      makeSignal(true),
      getTail,
      5_000,
      250,
    );

    await vi.runAllTimersAsync();
    expect(await promise).toBe(false);
    expect(getTail).not.toHaveBeenCalled();
  });

  it('returns false when already aborted, even for an empty prompt', async () => {
    // Abort is checked before the empty/preSendTail success paths, so a
    // superseded send is never reported as verified.
    const getTail = vi.fn().mockReturnValue('');
    const result = await pollUntilPromptAppearsInOutput(
      'agent-1',
      '',
      '',
      makeSignal(true),
      getTail,
      5_000,
      250,
    );
    expect(result).toBe(false);
    expect(getTail).not.toHaveBeenCalled();
  });

  it('returns false when signal is aborted during polling', async () => {
    vi.useFakeTimers();
    const ctrl = new AbortController();
    let callCount = 0;
    const getTail = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 2) ctrl.abort();
      return 'not yet';
    });

    const promise = pollUntilPromptAppearsInOutput(
      'agent-1',
      'build the feature',
      '',
      ctrl.signal,
      getTail,
      5_000,
      250,
    );

    await vi.runAllTimersAsync();
    expect(await promise).toBe(false);
  });

  // --- agentId pass-through ---

  it('passes agentId through to getTail', async () => {
    vi.useFakeTimers();
    const getTail = vi.fn().mockReturnValue('build the feature');

    const promise = pollUntilPromptAppearsInOutput(
      'my-specific-agent',
      'build the feature',
      '',
      makeSignal(),
      getTail,
      5_000,
      250,
    );

    await vi.runAllTimersAsync();
    await promise;
    expect(getTail).toHaveBeenCalledWith('my-specific-agent');
  });

  // --- Final deadline check ---
  // deadlineMs of 0 makes the polling loop body never run (Date.now() is never
  // < deadline), so only the post-loop final check can produce a match.

  it('matches via the final check when the echo lands at the deadline boundary', async () => {
    const getTail = vi.fn().mockReturnValue('build the feature');
    const result = await pollUntilPromptAppearsInOutput(
      'agent-1',
      'build the feature',
      '',
      makeSignal(),
      getTail,
      0,
      250,
    );
    expect(result).toBe(true);
    expect(getTail).toHaveBeenCalledTimes(1);
  });

  it('returns false from the final check when the echo never appears', async () => {
    const getTail = vi.fn().mockReturnValue('unrelated output');
    const result = await pollUntilPromptAppearsInOutput(
      'agent-1',
      'build the feature',
      '',
      makeSignal(),
      getTail,
      0,
      250,
    );
    expect(result).toBe(false);
    expect(getTail).toHaveBeenCalledTimes(1);
  });

  // --- TUI rendering of the echo ---

  it('matches a multi-line prompt the TUI renders with its own line breaks and indent', async () => {
    const getTail = vi
      .fn()
      .mockReturnValue(
        '\x1b[2K> should we write it?\r\n\x1b[2K\r\n\x1b[2K  Hello Johannes,\r\n\r\n  We would like to review',
      );
    const result = await pollUntilPromptAppearsInOutput(
      'agent-1',
      'should we write it?\n\n\nHello Johannes,\n\nWe would like to review',
      '',
      makeSignal(),
      getTail,
      0,
      250,
    );
    expect(result).toBe(true);
  });

  it('matches a long paste the TUI collapses into a placeholder', async () => {
    const getTail = vi.fn().mockReturnValue('> [Pasted text #1 +120 lines]');
    const result = await pollUntilPromptAppearsInOutput(
      'agent-1',
      `# Handover: landing page work\n${'details\n'.repeat(120)}`,
      '',
      makeSignal(),
      getTail,
      0,
      250,
    );
    expect(result).toBe(true);
  });

  it('matches a paste placeholder whose spaces the TUI draws as cursor moves', async () => {
    const getTail = vi
      .fn()
      .mockReturnValue('> [Pasted\x1b[1Ctext\x1b[1C#1\x1b[1C+120\x1b[1Clines]');
    const result = await pollUntilPromptAppearsInOutput(
      'agent-1',
      `# Handover: landing page work\n${'details\n'.repeat(120)}`,
      '',
      makeSignal(),
      getTail,
      0,
      250,
    );
    expect(result).toBe(true);
  });

  it('ignores a paste placeholder that was already on screen before sending', async () => {
    const getTail = vi.fn().mockReturnValue('> [Pasted text #1 +120 lines]');
    const result = await pollUntilPromptAppearsInOutput(
      'agent-1',
      'build the feature',
      '> [Pasted text #1 +120 lines]',
      makeSignal(),
      getTail,
      0,
      250,
    );
    expect(result).toBe(false);
  });
});
