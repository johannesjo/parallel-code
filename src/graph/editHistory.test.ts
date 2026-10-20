import { expect, it } from 'vitest';
import { createRoot } from 'solid-js';
import { createEditHistory } from './editHistory';

it('replays the same transition for undo and redo and drops redo on a new edit', () => {
  createRoot((dispose) => {
    const history = createEditHistory<number>(2);
    expect(history.step(false)).toBeUndefined();
    history.push({ before: 0, after: 1 });
    history.push({ before: 1, after: 2 });
    history.push({ before: 2, after: 3 });
    expect(history.step(false)).toEqual({ before: 2, after: 3 });
    expect(history.step(true)).toEqual({ before: 2, after: 3 });
    expect(history.canRedo()).toBe(false);
    expect(history.step(false)).toEqual({ before: 2, after: 3 });
    expect(history.step(false)).toEqual({ before: 1, after: 2 });
    expect(history.canUndo()).toBe(false);
    history.push({ before: 5, after: 6 });
    expect(history.canRedo()).toBe(false);
    history.reset();
    expect(history.canUndo()).toBe(false);
    dispose();
  });
});

it('puts a stepped entry back on its stack when the replay could not be saved', () => {
  createRoot((dispose) => {
    const history = createEditHistory<number>();
    history.push({ before: 0, after: 1 });
    expect(history.step(false)).toEqual({ before: 0, after: 1 });
    history.unstep(false);
    expect(history.canRedo()).toBe(false);
    expect(history.canUndo()).toBe(true);
    expect(history.step(false)).toEqual({ before: 0, after: 1 });
    expect(history.step(true)).toEqual({ before: 0, after: 1 });
    history.unstep(true);
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);
    expect(history.step(true)).toEqual({ before: 0, after: 1 });
    dispose();
  });
});
