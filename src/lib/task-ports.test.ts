import { describe, expect, it } from 'vitest';
import { expandPortVariable, isPortBase, pickPortBase } from './task-ports';

describe('pickPortBase', () => {
  it('starts at 20000 when no task holds a block', () => {
    expect(pickPortBase([])).toBe(20000);
  });

  it('fills the lowest gap left by a closed task', () => {
    expect(pickPortBase([20000, 20020])).toBe(20010);
    expect(pickPortBase([20000, 20010])).toBe(20020);
  });

  it('gives up once all 1000 blocks are taken', () => {
    const all = Array.from({ length: 1000 }, (_, i) => 20000 + i * 10);
    expect(pickPortBase(all)).toBeUndefined();
    expect(pickPortBase(all.slice(0, 999))).toBe(29990);
  });
});

describe('isPortBase', () => {
  it('accepts block starts and rejects anything else', () => {
    expect(isPortBase(20000)).toBe(true);
    expect(isPortBase(29990)).toBe(true);
    expect(isPortBase(20005)).toBe(false);
    expect(isPortBase(30000)).toBe(false);
    expect(isPortBase(19990)).toBe(false);
    expect(isPortBase('20000')).toBe(false);
  });
});

describe('expandPortVariable', () => {
  it('replaces every spelling of the variable', () => {
    expect(expandPortVariable('http://localhost:$PARALLEL_CODE_PORT/app', 20010)).toBe(
      'http://localhost:20010/app',
    );
    expect(expandPortVariable('http://127.0.0.1:${PARALLEL_CODE_PORT}', 20010)).toBe(
      'http://127.0.0.1:20010',
    );
    expect(expandPortVariable('localhost:%PARALLEL_CODE_PORT%', 20010)).toBe('localhost:20010');
  });

  it('leaves longer variable names alone', () => {
    expect(expandPortVariable('$PARALLEL_CODE_PORTS', 20010)).toBe('$PARALLEL_CODE_PORTS');
  });
});
