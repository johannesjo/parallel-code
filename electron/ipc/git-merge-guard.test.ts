import { describe, expect, it } from 'vitest';
import { blockingStatusLines } from './git.js';

describe('merge clean-tree guard', () => {
  it('lets the Kanban board alone through, but nothing else', () => {
    expect(blockingStatusLines(' M KANBAN.md\n')).toEqual([]);
    expect(blockingStatusLines('?? KANBAN.md\n')).toEqual([]);
    expect(blockingStatusLines(' M KANBAN.md\n M src/a.ts\n')).toEqual([' M src/a.ts']);
    expect(blockingStatusLines(' M docs/KANBAN.md\n')).toEqual([' M docs/KANBAN.md']);
    expect(blockingStatusLines('')).toEqual([]);
    // Staged or conflicted board changes are not the app's doing and still block.
    expect(blockingStatusLines('M  KANBAN.md\n')).toEqual(['M  KANBAN.md']);
    expect(blockingStatusLines('MM KANBAN.md\n')).toEqual(['MM KANBAN.md']);
    expect(blockingStatusLines('A  KANBAN.md\n')).toEqual(['A  KANBAN.md']);
    expect(blockingStatusLines('UU KANBAN.md\n')).toEqual(['UU KANBAN.md']);
    expect(blockingStatusLines('R  a.md -> KANBAN.md\n')).toEqual(['R  a.md -> KANBAN.md']);
  });
});
