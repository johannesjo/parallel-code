import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StatusDot } from './StatusDot';
import { clearAgentActivity, markAgentOutput, markAgentSpawned } from '../store/taskStatus';
import { removePrChecks, setPrChecks } from '../store/pr-checks-state';

vi.mock('../store/core', () => ({
  store: {
    tasks: { task: { id: 'task', agentIds: ['agent'], shellAgentIds: [] } },
    agents: { agent: { status: 'running', def: { name: 'Codex', command: 'codex' } } },
    activeTaskId: 'task',
    autoTrustFolders: false,
  },
  setStore: vi.fn(),
}));
vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));

let host: HTMLDivElement;
let dispose: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  host = document.createElement('div');
  markAgentSpawned('agent');
  dispose = render(() => <StatusDot status="busy" attention="active" taskId="task" />, host);
});

afterEach(() => {
  dispose?.();
  clearAgentActivity('agent');
  vi.useRealTimers();
});

function title(): string | null | undefined {
  return host.querySelector('.status-glyph')?.getAttribute('title');
}

function output(): void {
  markAgentOutput('agent', new TextEncoder().encode('Analyzing code...\r\n'), 'task');
}

it('refreshes terminal provenance and observation time while the agent stays active', () => {
  expect(title()).toContain('Activity unknown');
  output();
  expect(title()).toContain('Activity inferred from terminal output');
  expect(title()).toContain(new Date(Date.now()).toLocaleString());
  const previous = title();
  vi.advanceTimersByTime(1000);
  output();
  expect(title()).not.toBe(previous);
  expect(title()).toContain(new Date(Date.now()).toLocaleString());
});

it('clears the displayed output timestamp on replacement and cleanup', () => {
  output();
  markAgentSpawned('agent');
  expect(title()).toContain('observation time unknown');
  output();
  expect(title()).toContain('Activity inferred from terminal output');
  clearAgentActivity('agent');
  expect(title()).toContain('observation time unknown');
});

it('swaps the CI glyph when checks finish while it is on screen', () => {
  const ciHost = document.createElement('div');
  const checks = { passing: 1, pending: 1, failing: 0, checks: [], checkedAt: '' };
  setPrChecks('task', { ...checks, overall: 'pending' });
  const disposeCi = render(
    () => <StatusDot status="ready" attention="ready" taskId="task" />,
    ciHost,
  );
  expect(ciHost.querySelector('.status-glyph-ci')).not.toBeNull();

  setPrChecks('task', { ...checks, pending: 0, failing: 1, overall: 'failure' });
  expect(ciHost.querySelector('.status-glyph-ci')).toBeNull();
  expect(ciHost.querySelector('.status-glyph-question')?.textContent).toBe('×');
  expect(ciHost.querySelector('.status-glyph')?.getAttribute('title')).toContain('CI failed');

  disposeCi();
  removePrChecks('task');
});
