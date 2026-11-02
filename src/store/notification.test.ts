import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { store } from './core';
import {
  clearNotification,
  notificationAction,
  showNotification,
  showProgressNotification,
} from './notification';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  clearNotification();
  vi.useRealTimers();
});

const action = { label: 'Open review', run: () => {} };

it('keeps a notice’s button only while that notice shows', () => {
  showProgressNotification('Pushing…');
  showNotification('The review is ready.', { durationMs: 1_000, action });
  expect(notificationAction()).toBe(action);
  vi.advanceTimersByTime(1_000);
  expect(store.notification).toBe('Pushing…');
  expect(notificationAction()).toBeNull();
});

it('drops the button when another notice replaces its notice', () => {
  showNotification('The review is ready.', { action });
  showNotification('Copied.');
  expect(notificationAction()).toBeNull();
});
