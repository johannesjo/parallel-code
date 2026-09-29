import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { UsageStrip } from './UsageStrip';
import { fetchUsage } from './api';

vi.mock('./ws', () => ({ status: () => 'connected' }));
vi.mock('./api', () => ({ fetchUsage: vi.fn() }));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.innerHTML = '';
});

async function mount(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <UsageStrip />, host);
  await vi.waitFor(() => expect(fetchUsage).toHaveBeenCalled());
  await Promise.resolve();
  return host;
}

it('shows the providers the desktop has a snapshot for', async () => {
  vi.mocked(fetchUsage).mockResolvedValue({
    claude: {
      fiveHour: { usedPercent: 85, resetsAt: null },
      sevenDay: { usedPercent: 20, resetsAt: null },
      fetchedAt: 1,
      status: 'ok',
      error: null,
    },
    codex: { fiveHour: null, sevenDay: null, fetchedAt: null, status: 'unavailable', error: 'x' },
    antigravity: {
      fiveHour: { usedPercent: 30, resetsAt: null },
      sevenDay: null,
      fetchedAt: 1,
      status: 'ok',
      error: null,
    },
  });
  const host = await mount();
  await vi.waitFor(() => expect(host.querySelector('.mobile-usage')).not.toBeNull());
  expect(host.textContent).toContain('Claude');
  expect(host.textContent).toContain('Antigravity');
  expect(host.textContent).not.toContain('Codex');
  expect(host.textContent).toContain('15% left');
  expect(host.textContent).toContain('80% left');
  expect(host.textContent).toContain('70% left');
  expect(host.querySelector('.usage-meter.warn')).not.toBeNull();
});

it('stays hidden when no subscription usage is readable', async () => {
  vi.mocked(fetchUsage).mockResolvedValue({
    claude: { fiveHour: null, sevenDay: null, fetchedAt: null, status: 'unavailable', error: 'x' },
    codex: { fiveHour: null, sevenDay: null, fetchedAt: null, status: 'idle', error: null },
    antigravity: {
      fiveHour: null,
      sevenDay: null,
      fetchedAt: null,
      status: 'unavailable',
      error: null,
    },
  });
  const host = await mount();
  expect(host.querySelector('.mobile-usage')).toBeNull();
});
