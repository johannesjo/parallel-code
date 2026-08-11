import { describe, it, expect } from 'vitest';
import { store, setStore } from './core';
import { persistedSnapshot } from './autosave';

describe('autosave snapshot includes new-task-default fields', () => {
  it('defaultStepsEnabled changes the snapshot', () => {
    setStore('defaultStepsEnabled', false);
    const before = persistedSnapshot();
    setStore('defaultStepsEnabled', true);
    const after = persistedSnapshot();
    expect(before).not.toBe(after);
    setStore('defaultStepsEnabled', false);
  });

  it('defaultSkipPermissions changes the snapshot', () => {
    setStore('defaultSkipPermissions', false);
    const before = persistedSnapshot();
    setStore('defaultSkipPermissions', true);
    const after = persistedSnapshot();
    expect(before).not.toBe(after);
    setStore('defaultSkipPermissions', false);
  });

  it('defaultPropagateSkipPermissions changes the snapshot', () => {
    setStore('defaultPropagateSkipPermissions', false);
    const before = persistedSnapshot();
    setStore('defaultPropagateSkipPermissions', true);
    const after = persistedSnapshot();
    expect(before).not.toBe(after);
    setStore('defaultPropagateSkipPermissions', false);
  });

  it('showSteps is not tracked separately (migrated to defaultStepsEnabled)', () => {
    expect('showSteps' in store).toBe(false);
  });

  it('MiniMax model changes the snapshot', () => {
    setStore('minimaxModel', 'MiniMax-M3');
    const before = persistedSnapshot();
    setStore('minimaxModel', 'MiniMax-M2.7');
    const after = persistedSnapshot();
    expect(before).not.toBe(after);
    setStore('minimaxModel', 'MiniMax-M3');
  });
});
