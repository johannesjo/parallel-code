import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setStore } from './core';
import { scrollTaskIntoView } from './focused-panel';

let reducedMotion = false;
let scrolls: ScrollIntoViewOptions[] = [];

beforeEach(() => {
  reducedMotion = false;
  scrolls = [];
  vi.stubGlobal('matchMedia', () => ({ matches: reducedMotion }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  setStore({
    activeTaskId: 'task-1',
    focusMode: false,
    placeholderFocused: false,
    showNewTaskPanel: false,
    focusedPanel: { 'task-1': 'canvas' },
  });
  // The canvas branch scrolls the canvas itself, which keeps the spy simple.
  document.body.innerHTML =
    '<div data-task-id="task-1"><div class="task-canvas-panel"></div></div>';
  const canvas = document.querySelector<HTMLElement>('.task-canvas-panel');
  if (canvas)
    canvas.scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => {
      if (typeof options === 'object') scrolls.push(options);
    };
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

it('scrolls smoothly by default', () => {
  scrollTaskIntoView('task-1');
  expect(scrolls.map((s) => s.behavior)).toEqual(['smooth']);
});

it('jumps instantly when the OS asks for reduced motion', () => {
  reducedMotion = true;
  scrollTaskIntoView('task-1');
  expect(scrolls.map((s) => s.behavior)).toEqual(['instant']);
});
