import { describe, it, expect } from 'vitest';
import { createMockStoreHarness } from './test-helpers';

// Parity tests for the harness's setStore against real solid-js semantics.
// The harness once REPLACED objects at a path where solid MERGES them, which
// hid a production bug (stuck taskGitStatus flags). These lock the contract.

type TestStore = {
  nested: Record<string, { a?: number; b?: number; list?: number[]; date?: Date }>;
  flat: number;
};

function makeHarness() {
  return createMockStoreHarness<TestStore>({
    nested: { key: { a: 1, b: 2 } },
    flat: 0,
  });
}

describe('createMockStoreHarness setStore semantics', () => {
  it('merges plain objects at a path — omitted keys survive', () => {
    const h = makeHarness();
    h.applySetStore('nested', 'key', { a: 10 });
    expect(h.store.nested['key']).toEqual({ a: 10, b: 2 });
  });

  it('preserves object identity when merging', () => {
    const h = makeHarness();
    const before = h.state().nested['key'];
    h.applySetStore('nested', 'key', { a: 10 });
    expect(h.state().nested['key']).toBe(before);
  });

  it('deletes keys set to undefined inside a merged object', () => {
    const h = makeHarness();
    h.applySetStore('nested', 'key', { a: undefined, b: 5 });
    expect('a' in h.store.nested['key']).toBe(false);
    expect(h.store.nested['key'].b).toBe(5);
  });

  it('deletes the entry when the value itself is undefined', () => {
    const h = makeHarness();
    h.applySetStore('nested', 'key', undefined);
    expect('key' in h.store.nested).toBe(false);
  });

  it('replaces arrays instead of merging them', () => {
    const h = makeHarness();
    h.applySetStore('nested', 'key', { list: [1, 2, 3] });
    h.applySetStore('nested', 'key', { list: [9] });
    expect(h.store.nested['key'].list).toEqual([9]);
  });

  it('replaces non-plain objects instead of merging them', () => {
    const h = makeHarness();
    const first = new Date(1_000);
    const second = new Date(2_000);
    h.applySetStore('nested', 'key', { date: first });
    h.applySetStore('nested', 'key', { date: second });
    expect(h.store.nested['key'].date).toBe(second);
  });

  it('replaces primitives at a path', () => {
    const h = makeHarness();
    h.applySetStore('flat', 42);
    expect(h.store.flat).toBe(42);
  });
});
