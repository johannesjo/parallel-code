import { expect, it } from 'vitest';
import { getTaskViewportVisibility, setTaskViewportVisibility } from './ui';

it('replaces the viewport visibility map instead of merging into it', () => {
  setTaskViewportVisibility({ a: 'offscreen-left', b: 'visible' });
  // Focus mode and a hidden strip report no tiles; old entries must not linger
  // as "off to the left" badges in the sidebar.
  setTaskViewportVisibility({});
  expect(getTaskViewportVisibility('a')).toBeNull();
  setTaskViewportVisibility({ b: 'offscreen-right' });
  expect(getTaskViewportVisibility('b')).toBe('offscreen-right');
  expect(getTaskViewportVisibility('a')).toBeNull();
});
