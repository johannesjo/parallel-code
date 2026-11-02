import { describe, expect, it } from 'vitest';
import { stepInGrid } from './task-board-keys';

describe('stepInGrid', () => {
  const grid = [['a1', 'a2', 'a3'], ['b1'], ['c1', 'c2']];

  it('moves up and down within a column and stops at its ends', () => {
    expect(stepInGrid(grid, 'a1', 'down')).toBe('a2');
    expect(stepInGrid(grid, 'a2', 'up')).toBe('a1');
    expect(stepInGrid(grid, 'a1', 'up')).toBeUndefined();
    expect(stepInGrid(grid, 'a3', 'down')).toBeUndefined();
  });

  it('keeps the row sideways, clamped to a shorter column', () => {
    expect(stepInGrid(grid, 'a3', 'right')).toBe('b1');
    expect(stepInGrid(grid, 'b1', 'right')).toBe('c1');
    expect(stepInGrid(grid, 'c2', 'left')).toBe('b1');
  });

  it('reports the grid edges sideways', () => {
    expect(stepInGrid(grid, 'a2', 'left')).toBeUndefined();
    expect(stepInGrid(grid, 'c1', 'right')).toBeUndefined();
  });

  it('jumps to the ends of a column', () => {
    expect(stepInGrid(grid, 'a2', 'first')).toBe('a1');
    expect(stepInGrid(grid, 'a1', 'last')).toBe('a3');
    expect(stepInGrid(grid, 'a1', 'first')).toBeUndefined();
  });

  it('finds nothing for an item outside the grid', () => {
    expect(stepInGrid(grid, 'zz', 'down')).toBeUndefined();
  });
});
