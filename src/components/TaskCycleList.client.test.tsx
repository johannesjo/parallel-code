import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initShortcuts, registerShortcut } from '../lib/shortcuts';
import { setStore } from '../store/core';
import { CYCLE_REVEAL_MS, cancelCycle, cycleBack, cycleForward } from './task-cycle';
import { TaskCycleList } from './TaskCycleList';

const nav = vi.hoisted(() => ({
  waiting: [] as string[],
  next: undefined as string | undefined,
  opened: [] as string[],
  tappedNext: 0,
  wentBack: 0,
}));
vi.mock('./next-attention-task', () => ({
  attentionTargets: () => ({ ids: nav.waiting, next: nav.next }),
  openCycledItem: (id: string) => nav.opened.push(id),
  openNextAttentionTask: () => nav.tappedNext++,
  openPreviousTask: () => nav.wentBack++,
}));
// Open items in tile order; names are the ids so rows are easy to read.
vi.mock('./TaskSwitcher', () => ({
  switcherItems: () => ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id, detail: '' })),
  switcherItem: (id: string) => ({ id, name: id, detail: '' }),
}));

let cleanups: (() => void)[] = [];

const key = (type: 'keydown' | 'keyup', init: KeyboardEventInit) =>
  window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
const ctrlTab = (shiftKey = false) => key('keydown', { key: 'Tab', ctrlKey: true, shiftKey });
const releaseCtrl = () => key('keyup', { key: 'Control', ctrlKey: false });
const rows = () => [...document.querySelectorAll('.task-cycle [role="option"]')];
const rowNames = () => rows().map((row) => row.querySelector('.task-switcher-name')?.textContent);
const selected = () =>
  document.querySelector('.task-cycle [aria-selected="true"] .task-switcher-name')?.textContent;

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(nav, { waiting: ['c', 'a'], next: 'a', opened: [], tappedNext: 0, wentBack: 0 });
  setStore('activeTaskId', 'c');
  const host = document.createElement('div');
  document.body.append(host);
  cleanups = [
    initShortcuts(),
    registerShortcut({
      key: 'Tab',
      modifiers: { ctrl: true },
      global: true,
      handler: cycleForward,
    }),
    registerShortcut({
      key: 'Tab',
      modifiers: { ctrl: true, shift: true },
      global: true,
      handler: () => cycleBack(),
    }),
    render(() => <TaskCycleList />, host),
    () => host.remove(),
  ];
});

afterEach(() => {
  cancelCycle();
  cleanups.forEach((fn) => fn());
  vi.useRealTimers();
});

describe('held Ctrl+Tab list', () => {
  it('jumps to the next waiting task on a quick tap, without showing the list', () => {
    ctrlTab();
    vi.advanceTimersByTime(CYCLE_REVEAL_MS - 1);
    expect(rows()).toHaveLength(0);
    expect(nav.opened).toEqual([]);
    releaseCtrl();
    expect(nav.opened).toEqual(['a']);
    vi.advanceTimersByTime(CYCLE_REVEAL_MS);
    expect(rows()).toHaveLength(0);
  });

  it('shows every open item, waiting ones first, once Ctrl is held', () => {
    ctrlTab();
    vi.advanceTimersByTime(CYCLE_REVEAL_MS);
    expect(rowNames()).toEqual(['c', 'a', 'b', 'd']);
    expect(selected()).toBe('a');
    expect(document.querySelector('[aria-current="true"] .task-switcher-name')?.textContent).toBe(
      'c',
    );
  });

  it('moves with Tab and Shift+Tab, wrapping, and switches on release', () => {
    ctrlTab();
    ctrlTab();
    // A second Tab shows the list at once instead of waiting.
    expect(selected()).toBe('b');
    ctrlTab();
    ctrlTab();
    expect(selected()).toBe('c');
    ctrlTab(true);
    expect(selected()).toBe('d');
    releaseCtrl();
    expect(nav.opened).toEqual(['d']);
    expect(rows()).toHaveLength(0);
  });

  it('does not switch when released on the current task', () => {
    nav.next = undefined;
    ctrlTab();
    releaseCtrl();
    expect(nav.opened).toEqual([]);
  });

  it('keeps Tab from the terminal but leaves Escape to cancel without switching', () => {
    ctrlTab();
    ctrlTab();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', ctrlKey: true, cancelable: true });
    window.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(rows()).toHaveLength(0);
    releaseCtrl();
    expect(nav.opened).toEqual([]);
  });

  it('moves with the arrow keys and switches on the next key when the release was missed', () => {
    ctrlTab();
    key('keydown', { key: 'ArrowDown', ctrlKey: true });
    key('keydown', { key: 'ArrowDown', ctrlKey: true });
    key('keydown', { key: 'ArrowUp', ctrlKey: true });
    expect(selected()).toBe('b');
    key('keydown', { key: 'x' });
    expect(nav.opened).toEqual(['b']);
  });

  it('switches to a clicked row', () => {
    ctrlTab();
    vi.advanceTimersByTime(CYCLE_REVEAL_MS);
    (rows()[2] as HTMLElement).click();
    expect(nav.opened).toEqual(['b']);
    expect(rows()).toHaveLength(0);
  });

  it('dims the app behind the list, and a click on the backdrop leaves without switching', () => {
    ctrlTab();
    vi.advanceTimersByTime(CYCLE_REVEAL_MS);
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    rows()[2]?.dispatchEvent(press);
    // Keeps the keyboard in its pane, and the list open for the click.
    expect(press.defaultPrevented).toBe(true);
    expect(rows()).toHaveLength(4);
    (document.querySelector('.task-cycle-backdrop') as HTMLElement).click();
    expect(rows()).toHaveLength(0);
    releaseCtrl();
    expect(nav.opened).toEqual([]);
  });

  // On macOS a click with Ctrl down is a right-click: no click event follows.
  it('treats a Ctrl-click (context menu) like a click, without opening a menu', () => {
    ctrlTab();
    vi.advanceTimersByTime(CYCLE_REVEAL_MS);
    const menu = () => new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    const onRow = menu();
    rows()[2]?.dispatchEvent(onRow);
    expect(onRow.defaultPrevented).toBe(true);
    expect(nav.opened).toEqual(['b']);
    ctrlTab();
    vi.advanceTimersByTime(CYCLE_REVEAL_MS);
    const onBackdrop = menu();
    document.querySelector('.task-cycle-backdrop')?.dispatchEvent(onBackdrop);
    expect(onBackdrop.defaultPrevented).toBe(true);
    expect(rows()).toHaveLength(0);
    expect(nav.opened).toEqual(['b']);
  });

  it('cancels when the window loses focus', () => {
    ctrlTab();
    window.dispatchEvent(new Event('blur'));
    releaseCtrl();
    expect(nav.opened).toEqual([]);
  });

  it('stays open when focus moves inside the window, as a click on a row does', () => {
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    textarea.focus();
    ctrlTab();
    textarea.blur();
    textarea.remove();
    releaseCtrl();
    expect(nav.opened).toEqual(['a']);
  });

  it('keeps the old one-press behaviour without a modifier to hold, and for Ctrl+Shift+Tab', () => {
    cycleForward(new KeyboardEvent('keydown'));
    expect(nav.tappedNext).toBe(1);
    ctrlTab(true);
    expect(nav.wentBack).toBe(1);
    expect(rows()).toHaveLength(0);
  });
});
