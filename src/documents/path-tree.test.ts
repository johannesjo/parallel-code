import { describe, expect, it } from 'vitest';
import { buildPathTree } from './path-tree';

describe('buildPathTree', () => {
  it('nests folders before files, both sorted by name', () => {
    const tree = buildPathTree(['readme.md', 'src/b.md', 'src/a.md', 'assets/logo.png', 'a.md']);
    expect(tree.map((n) => n.path)).toEqual(['assets', 'src', 'a.md', 'readme.md']);
    expect(tree[1].children.map((n) => n.path)).toEqual(['src/a.md', 'src/b.md']);
    expect(tree[1].children[0].children).toEqual([]);
  });

  it('is empty for no paths', () => {
    expect(buildPathTree([])).toEqual([]);
  });
});
