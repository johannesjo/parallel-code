import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { BranchPrefixField } from './BranchPrefixField';

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
});

function previewText(worktreeFolder?: string): string | undefined {
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(
    () => (
      <BranchPrefixField
        branchPrefix="task"
        branchPreview="task/fix-login"
        projectPath="/repo"
        worktreeFolder={worktreeFolder}
        onPrefixChange={() => {}}
      />
    ),
    host,
  );
  return [...host.querySelectorAll('span')].at(-1)?.textContent ?? undefined;
}

describe('BranchPrefixField', () => {
  it('previews the default .worktrees location', () => {
    expect(previewText()).toBe('/repo/.worktrees/task/fix-login');
  });

  it('previews the configured worktree folder', () => {
    expect(previewText('~/worktrees/repo/')).toBe('~/worktrees/repo/task/fix-login');
  });
});
