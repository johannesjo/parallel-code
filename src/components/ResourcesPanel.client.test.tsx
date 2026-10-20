import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResourceSnapshot } from '../ipc/types';
import { ResourcesPanel } from './ResourcesPanel';

const { mockInvoke, snapshot } = vi.hoisted(() => {
  const snapshot: ResourceSnapshot = {
    cpuCount: 8,
    totalMemoryBytes: 16 * 1024 ** 3,
    sampledAt: 0,
    groups: [
      {
        kind: 'app',
        agentId: null,
        taskId: null,
        cpuPercent: 4,
        memoryBytes: 500 * 1024 ** 2,
        processes: [{ pid: 10, name: 'Browser', cpuPercent: 4, memoryBytes: 500 * 1024 ** 2 }],
      },
      {
        kind: 'agent',
        agentId: 'a1',
        taskId: 't1',
        cpuPercent: 80,
        memoryBytes: 1024 ** 3,
        processes: [{ pid: 21, name: 'claude', cpuPercent: 80, memoryBytes: 1024 ** 3 }],
      },
    ],
  };
  return { mockInvoke: vi.fn(async () => snapshot), snapshot };
});

vi.mock('../lib/ipc', () => ({ invoke: mockInvoke }));
vi.mock('../store/store', () => ({
  store: {
    tasks: { t1: { name: 'Fix login' } },
    agents: { a1: { def: { name: 'Claude Code' } } },
    terminals: {},
  },
}));

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  mockInvoke.mockClear();
  vi.useRealTimers();
});

function mount(): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  disposers.push(render(() => <ResourcesPanel />, container));
  return container;
}

const panel = () => document.querySelector<HTMLElement>('[data-testid="resources-panel"]');
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const toggleButton = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('button') as HTMLButtonElement;

describe('ResourcesPanel', () => {
  it('shows the live machine total on the button before opening', async () => {
    const container = mount();
    await flush();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(panel()).toBeNull();
    // 84% of one core on 8 cores; 500 MB + 1 GB.
    expect(toggleButton(container).textContent).toBe('Resources11% · 1.5 GB');
    expect(toggleButton(container).style.color).not.toBe('var(--warning)');
  });

  it('turns the button to the warning colour when the machine is busy', async () => {
    mockInvoke.mockImplementationOnce(async () => ({ ...snapshot, cpuCount: 1 }));
    const container = mount();
    await flush();
    expect(toggleButton(container).style.color).toBe('var(--warning)');
  });

  it.each([
    ['CPU below capacity', 89, 10, 'var(--warning)'],
    ['CPU near capacity', 90, 10, 'var(--error)'],
    ['CPU above capacity', 110, 10, 'var(--error)'],
    ['RAM below capacity', 10, 89, 'var(--fg-muted)'],
    ['RAM near capacity', 10, 90, 'var(--error)'],
    ['RAM above capacity with busy CPU', 50, 95, 'var(--error)'],
  ])('uses the expected colour for %s', async (_label, cpu, memory, color) => {
    mockInvoke.mockImplementationOnce(async () => ({
      ...snapshot,
      groups: snapshot.groups.map((group) => ({
        ...group,
        cpuPercent: (cpu * snapshot.cpuCount) / snapshot.groups.length,
        memoryBytes: ((memory / 100) * snapshot.totalMemoryBytes) / snapshot.groups.length,
      })),
    }));
    const container = mount();
    await flush();
    expect(toggleButton(container).style.color).toBe(color);
    // Opening the panel triggers a fresh sample with normal usage.
    toggleButton(container).click();
    await flush();
    expect(toggleButton(container).style.color).toBe('var(--fg)');
  });

  it('keeps red while open and recovers when a later poll reports normal usage', async () => {
    vi.useFakeTimers();
    const highUsage = {
      ...snapshot,
      totalMemoryBytes: 1024 ** 3,
    };
    mockInvoke.mockResolvedValueOnce(highUsage).mockResolvedValueOnce(highUsage);
    const container = mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(toggleButton(container).style.color).toBe('var(--error)');
    toggleButton(container).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(toggleButton(container).style.color).toBe('var(--error)');
    await vi.advanceTimersByTimeAsync(2000);
    expect(toggleButton(container).style.color).toBe('var(--fg)');
  });

  it('lists groups by cpu with task names, and expands into processes', async () => {
    const container = mount();
    toggleButton(container).click();
    await flush();
    const rows = [...(panel()?.querySelectorAll('button[aria-expanded]') ?? [])];
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Fix login · Claude Code10%1.0 GB'),
      expect.stringContaining('Parallel Code0.5%500 MB'),
    ]);
    expect(panel()?.textContent).not.toContain('claude 21');
    (rows[0] as HTMLButtonElement).click();
    expect(panel()?.textContent).toContain('claude 21');
  });

  it('keeps an expanded row open across polls and slows down when closed', async () => {
    vi.useFakeTimers();
    const container = mount();
    toggleButton(container).click();
    await vi.advanceTimersByTimeAsync(0);
    panel()?.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click();
    await vi.advanceTimersByTimeAsync(2000);
    const whileOpen = mockInvoke.mock.calls.length;
    expect(panel()?.textContent).toContain('claude 21');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(panel()).toBeNull();
    const afterClose = mockInvoke.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(mockInvoke.mock.calls.length).toBe(afterClose);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockInvoke.mock.calls.length).toBe(afterClose + 1);
    expect(whileOpen).toBeGreaterThan(1);
  });

  it('waits for a slow sample instead of stacking requests', async () => {
    vi.useFakeTimers();
    let resolve: (value: ResourceSnapshot) => void = () => {};
    mockInvoke.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    mount();
    await vi.advanceTimersByTimeAsync(15000);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    resolve(snapshot);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it('skips samples while the window is hidden', async () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    mount();
    await vi.advanceTimersByTimeAsync(10000);
    expect(mockInvoke).not.toHaveBeenCalled();
    hidden.mockRestore();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('ignores a slow reply from a superseded poller', async () => {
    let resolveStale: (value: ResourceSnapshot) => void = () => {};
    mockInvoke.mockImplementationOnce(() => new Promise((r) => (resolveStale = r)));
    const container = mount();
    toggleButton(container).click();
    await flush();
    resolveStale({ ...snapshot, groups: [] });
    await flush();
    expect(toggleButton(container).textContent).toBe('Resources11% · 1.5 GB');
  });

  it('shows an error when sampling fails', async () => {
    const container = mount();
    await flush();
    mockInvoke.mockImplementationOnce(() => Promise.reject(new Error('EPERM')));
    toggleButton(container).click();
    await flush();
    expect(panel()?.textContent).toContain('Could not read processes: Error: EPERM');
  });
});
