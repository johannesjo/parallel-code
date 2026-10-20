import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readProcessTable } = vi.hoisted(() => ({ readProcessTable: vi.fn() }));

vi.mock('electron', () => ({ app: { getAppMetrics: () => [] } }));
vi.mock('./pty.js', () => ({ getPtyProcessRoots: () => [] }));
vi.mock('./process-stats.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./process-stats.js')>()),
  readProcessTable,
}));

describe('getResourceSnapshot', () => {
  beforeEach(() => {
    vi.resetModules();
    readProcessTable.mockReset().mockResolvedValue([]);
  });

  it('shares one sample between overlapping and back-to-back callers', async () => {
    const { getResourceSnapshot } = await import('./resources.js');
    const [a, b] = await Promise.all([getResourceSnapshot(), getResourceSnapshot()]);
    const c = await getResourceSnapshot();
    expect(readProcessTable).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('samples again once the minimum gap has passed', async () => {
    vi.useFakeTimers();
    const { getResourceSnapshot } = await import('./resources.js');
    await getResourceSnapshot();
    vi.advanceTimersByTime(600);
    await getResourceSnapshot();
    expect(readProcessTable).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
