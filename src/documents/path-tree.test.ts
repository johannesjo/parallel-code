import { describe, expect, it } from 'vitest';
import { buildPathTree, pushRecentPath } from './path-tree';

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

describe('pushRecentPath', () => {
  it('moves a reopened file to the front without duplicating it', () => {
    expect(pushRecentPath(['a.md', 'b.md', 'c.md'], 'b.md')).toEqual(['b.md', 'a.md', 'c.md']);
  });

  it('keeps only the five newest', () => {
    const recent = ['a', 'b', 'c', 'd', 'e'];
    expect(pushRecentPath(recent, 'f')).toEqual(['f', 'a', 'b', 'c', 'd']);
  });
});
