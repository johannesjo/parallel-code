import { describe, expect, it } from 'vitest';
import { shellBadge } from './shell-badge';

describe('shellBadge', () => {
  it('names the run and tints only a failure', () => {
    expect(shellBadge({ run: { name: 'web', state: 'running' } })).toEqual({
      text: 'web running',
      tone: 'muted',
    });
    expect(
      shellBadge({ run: { name: 'web', state: 'stopped' }, exit: { exitCode: 130, signal: null } }),
    ).toEqual({ text: 'web stopped', tone: 'muted' });
    expect(
      shellBadge({
        run: { name: 'build', state: 'finished' },
        exit: { exitCode: 0, signal: null },
      }),
    ).toEqual({ text: 'build finished', tone: 'muted' });
    expect(
      shellBadge({ run: { name: 'web', state: 'failed' }, exit: { exitCode: 1, signal: null } }),
    ).toEqual({ text: 'web failed (exit 1)', tone: 'error' });
  });

  it('keeps the setup and plain-shell badges as they were', () => {
    expect(shellBadge({ setup: 'running' })?.text).toBe('Setup script running…');
    expect(shellBadge({ setup: 'passed' })?.text).toBe('Setup script finished');
    expect(shellBadge({ setup: 'failed', exit: { exitCode: 2, signal: null } })).toEqual({
      text: 'Setup script failed (exit 2)',
      tone: 'error',
    });
    expect(shellBadge({})).toBeUndefined();
    expect(shellBadge({ exit: { exitCode: 0, signal: null } })).toEqual({
      text: 'Process exited (0)',
      tone: 'success',
    });
  });
});
