import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRestoreWindow } = vi.hoisted(() => ({ mockRestoreWindow: vi.fn() }));
vi.mock('electron', () => ({ app: { isPackaged: false, setAsDefaultProtocolClient: vi.fn() } }));
vi.mock('../window-restore.js', () => ({ restoreWindow: mockRestoreWindow }));
vi.mock('../log.js', () => ({ warn: vi.fn() }));

import { consumePendingSpOpen, findProtocolUrl, handleProtocolUrl } from './protocol.js';

function fakeWindow() {
  return { isDestroyed: () => false, webContents: { send: vi.fn() } };
}

describe('parallelcode:// handling', () => {
  beforeEach(() => {
    consumePendingSpOpen();
    mockRestoreWindow.mockClear();
  });

  it('finds the link among launch arguments', () => {
    expect(findProtocolUrl(['/opt/app', '--flag', 'ParallelCode://new-task?spTaskId=a'])).toBe(
      'ParallelCode://new-task?spTaskId=a',
    );
    expect(findProtocolUrl(['/opt/app', '/home/me/file.txt'])).toBeUndefined();
  });

  it('parks the id, raises the window and nudges the renderer', () => {
    const win = fakeWindow();
    handleProtocolUrl('parallelcode://new-task?spTaskId=abc', win as never);
    expect(mockRestoreWindow).toHaveBeenCalledWith(win);
    expect(win.webContents.send).toHaveBeenCalledWith('super_productivity_open_task_requested');
    expect(consumePendingSpOpen()).toBe('abc');
    expect(consumePendingSpOpen()).toBeNull();
  });

  it('keeps the latest link, and parks one that arrives before the window exists', () => {
    handleProtocolUrl('parallelcode://new-task?spTaskId=first', null);
    handleProtocolUrl('parallelcode://new-task?spTaskId=second', null);
    expect(consumePendingSpOpen()).toBe('second');
  });

  it('raises the window for an invalid link but parks nothing', () => {
    const win = fakeWindow();
    handleProtocolUrl('parallelcode://run?cmd=rm', win as never);
    expect(mockRestoreWindow).toHaveBeenCalledWith(win);
    expect(win.webContents.send).not.toHaveBeenCalled();
    expect(consumePendingSpOpen()).toBeNull();
  });
});
