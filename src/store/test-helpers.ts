import { vi } from 'vitest';
import type { Mock } from 'vitest';

export type MockStoreExtra = Record<string, unknown>;

export type MockStoreHarness<TStore extends object> = {
  readonly store: TStore;
  readonly setStore: Mock<(...args: unknown[]) => void>;
  state(): TStore;
  reset(next: TStore): TStore;
  applySetStore(...args: unknown[]): void;
  moduleMock(
    extra?: MockStoreExtra,
  ): { store: TStore; setStore: Mock<(...args: unknown[]) => void> } & MockStoreExtra;
};

type Producer<T> = (draft: T) => unknown;

export function expectDefined<T>(value: T | null | undefined, label = 'value'): T {
  if (value === null || value === undefined) throw new Error(`${label} is not defined`);
  return value;
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/** Mirrors solid's isWrappable (minus store proxies): plain objects and arrays.
 *  Class instances, functions, Maps etc. are replaced, never merged. */
function isWrappable(value: unknown): value is Record<PropertyKey, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return true;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/** Mirrors solid's mergeStoreNode: keys are set one by one on the existing
 *  object (identity preserved); an explicit `undefined` deletes the key. */
function mergeInto(
  target: Record<PropertyKey, unknown>,
  source: Record<PropertyKey, unknown>,
): void {
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (value === undefined) delete target[key];
    else target[key] = value;
  }
}

function getContainer(target: unknown, key: PropertyKey): Record<PropertyKey, unknown> | undefined {
  if (!isObject(target)) return undefined;
  const next = target[key];
  return isObject(next) ? next : undefined;
}

function setPath(target: unknown, path: unknown[], value: unknown): void {
  if (path.length === 0) return;
  let parent = target;
  for (const key of path.slice(0, -1)) {
    const next = getContainer(parent, key as PropertyKey);
    if (!next) return;
    parent = next;
  }
  if (!isObject(parent)) return;
  const key = path[path.length - 1] as PropertyKey;
  const prev = parent[key];
  // Faithful to solid's updatePath: when both the existing value and the new
  // value are wrappable and the new value is not an array, setStore MERGES
  // instead of replacing — keys omitted from the new object survive the write.
  // A harness that replaced here hid exactly that class of production bug.
  if (isWrappable(prev) && isWrappable(value) && !Array.isArray(value)) {
    mergeInto(prev, value);
  } else if (value === undefined) {
    delete parent[key];
  } else {
    parent[key] = value;
  }
}

function readPath(target: unknown, path: unknown[]): unknown {
  let current = target;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = current[key as PropertyKey];
  }
  return current;
}

export function createMockStoreHarness<TStore extends object>(
  initial: TStore,
): MockStoreHarness<TStore> {
  let current = initial;
  const store = new Proxy({} as TStore, {
    get(_target, prop) {
      return current[prop as keyof TStore];
    },
    set(_target, prop, value) {
      current[prop as keyof TStore] = value as TStore[keyof TStore];
      return true;
    },
    has(_target, prop) {
      return prop in current;
    },
    ownKeys() {
      return Reflect.ownKeys(current);
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (!(prop in current)) return undefined;
      return { configurable: true, enumerable: true, value: current[prop as keyof TStore] };
    },
  });

  const applySetStore = (...args: unknown[]): void => {
    if (args.length === 0) return;
    if (args.length === 1 && typeof args[0] === 'function') {
      (args[0] as Producer<TStore>)(current);
      return;
    }
    if (args.length >= 2 && typeof args[args.length - 1] === 'function') {
      const path = args.slice(0, -1);
      const target = readPath(current, path);
      const next = (args[args.length - 1] as Producer<unknown>)(target);
      if (next !== undefined) setPath(current, path, next);
      return;
    }
    setPath(current, args.slice(0, -1), args[args.length - 1]);
  };

  const setStore = vi.fn((...args: unknown[]) => applySetStore(...args));

  return {
    store,
    setStore,
    state: () => current,
    reset(next) {
      current = next;
      setStore.mockClear();
      setStore.mockImplementation((...args: unknown[]) => applySetStore(...args));
      return current;
    },
    applySetStore,
    moduleMock(extra = {}) {
      return { store, setStore, ...extra };
    },
  };
}

export function mockSolidStoreProduce(): {
  produce: <TProducer>(producer: TProducer) => TProducer;
} {
  return {
    produce: (producer) => producer,
  };
}
