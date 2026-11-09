import { describe, expect, it } from 'vitest';
import { createSymlinkCandidateState } from './symlink-candidates';
import { splitIncludeSelection } from './worktree-includes';

const entries = [
  { name: 'node_modules', isDefault: true },
  { name: '.env', isDefault: true },
  { name: 'docs-local', isDefault: false },
];

describe('createSymlinkCandidateState', () => {
  it('starts from the built-in defaults when the project saved no list', async () => {
    const state = createSymlinkCandidateState(async () => entries);
    await state.load('/repo', true);
    expect(state.dirs()).toEqual(['node_modules', '.env', 'docs-local']);
    expect([...state.selected()]).toEqual(['node_modules', '.env']);
    expect(splitIncludeSelection(state.selected(), state.copyDirs())).toEqual({
      symlinkDirs: ['node_modules', '.env'],
      copyDirs: [],
    });
  });

  it('starts from the saved list, with its copies, when the project has one', async () => {
    const state = createSymlinkCandidateState(async () => entries);
    await state.load('/repo', true, [
      { name: '.env', mode: 'copy' },
      { name: 'docs-local', mode: 'symlink' },
    ]);
    expect(splitIncludeSelection(state.selected(), state.copyDirs())).toEqual({
      symlinkDirs: ['docs-local'],
      copyDirs: ['.env'],
    });
    // Unchecking a copy for one task sends it in neither list.
    state.toggle('.env');
    expect(splitIncludeSelection(state.selected(), state.copyDirs())).toEqual({
      symlinkDirs: ['docs-local'],
      copyDirs: [],
    });
  });

  it('clears copies along with the selection when the project changes', async () => {
    const state = createSymlinkCandidateState(async () => entries);
    await state.load('/repo', true, [{ name: '.env', mode: 'copy' }]);
    await state.load('/other', true);
    expect(state.copyDirs().size).toBe(0);
  });
});
