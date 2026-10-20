import { describe, expect, it } from 'vitest';
import { shouldDisableImportClose } from './ImportWorktreesDialog';

describe('shouldDisableImportClose', () => {
  it('prevents closing while selected worktrees are importing', () => {
    expect(shouldDisableImportClose(true)).toBe(true);
  });

  it('allows closing while the dialog is idle', () => {
    expect(shouldDisableImportClose(false)).toBe(false);
  });
});
