import { describe, expect, it } from 'vitest';
import { autoShellLayout, shellColumns } from './shellLayout';

describe('autoShellLayout', () => {
  const auto = (width: number, count: number, prev: 'row' | 'grid' | 'column' = 'row') =>
    autoShellLayout({ width, count, split: true, prev });

  it('keeps shells side by side outside the split layout', () => {
    expect(autoShellLayout({ width: 300, count: 4, split: false, prev: 'column' })).toBe('row');
  });

  it('keeps a single shell in a row', () => {
    expect(auto(200, 1, 'column')).toBe('row');
  });

  it('stacks shells in the default 420px side column', () => {
    expect(auto(420, 3, 'row')).toBe('column');
  });

  it('uses a square grid once two shells fit per row', () => {
    expect(auto(720, 4, 'column')).toBe('grid');
  });

  it('puts shells side by side when all of them fit', () => {
    expect(auto(1100, 3, 'column')).toBe('row');
  });

  it('stacks rather than squeezing a larger square grid below the minimum width', () => {
    expect(auto(720, 5, 'column')).toBe('column');
    expect(auto(1060, 5, 'column')).toBe('grid');
  });

  it('gives no hysteresis bonus on the first measurement', () => {
    expect(autoShellLayout({ width: 690, count: 2, split: true })).toBe('column');
  });

  it('keeps the previous mode just below its threshold', () => {
    expect(auto(690, 4, 'grid')).toBe('grid');
    expect(auto(690, 4, 'column')).toBe('column');
    expect(auto(660, 4, 'grid')).toBe('column');
  });
});

describe('shellColumns', () => {
  it('maps each mode to shells per row', () => {
    expect(shellColumns('row', 3)).toBe(3);
    expect(shellColumns('grid', 4)).toBe(2);
    expect(shellColumns('grid', 3)).toBe(2);
    expect(shellColumns('grid', 5)).toBe(3);
    expect(shellColumns('column', 3)).toBe(1);
    expect(shellColumns('row', 0)).toBe(1);
  });
});
