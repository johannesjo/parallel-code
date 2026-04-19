import { describe, expect, it } from 'vitest';
import config from './vite.config.electron';

describe('electron vite config', () => {
  it('ignores nested worktree directories in dev watch mode', () => {
    const ignored = config.server?.watch?.ignored;

    expect(ignored).toBeDefined();

    const patterns = Array.isArray(ignored) ? ignored : [ignored];
    expect(patterns).toContain('**/.worktrees/**');
  });
});
