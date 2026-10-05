import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { AgentList } from './AgentList';
import { connect, reconnect } from './ws';
import type { RemoteAgent } from '../../electron/remote/protocol';

// Usage meters poll over HTTP; they have their own tests.
vi.mock('./UsageStrip', () => ({ UsageStrip: () => null }));

class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  static current: Socket;
  readyState = Socket.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() {
    Socket.current = this;
  }
  send() {}
  close() {
    this.readyState = 3;
  }
}

let host: HTMLDivElement;
let dispose: () => void;
beforeEach(() => {
  vi.stubGlobal('WebSocket', Socket);
  localStorage.setItem('parallel-code-token', 'view-only');
  host = document.createElement('div');
  document.body.append(host);
  connect();
});
afterEach(() => {
  dispose?.();
  host.remove();
  localStorage.clear();
  reconnect();
  vi.unstubAllGlobals();
});

it('keeps a focused task card mounted when live preview text and project color change', () => {
  const agent: RemoteAgent = {
    agentId: 'a1',
    taskId: 't1',
    taskName: 'Test task',
    projectName: 'Project',
    projectColor: '#ff0000',
    status: 'running',
    attention: 'active',
    exitCode: null,
    lastLine: 'Starting',
  };
  const publish = (list: RemoteAgent[]) =>
    Socket.current.onmessage?.({ data: JSON.stringify({ type: 'agents', list }) });
  publish([agent]);
  dispose = render(
    () => <AgentList onSelect={() => {}} onNewTask={() => {}} onPair={() => {}} />,
    host,
  );
  const card = host.querySelector<HTMLButtonElement>('.agent-card');
  if (!card) throw new Error('Missing task card');
  const swatch = () => card.querySelector<HTMLElement>('.project-swatch');
  expect(swatch()?.style.background).toBe('#ff0000');
  card.focus();
  publish([{ ...agent, lastLine: 'Running tests', projectColor: '#0000ff' }]);
  expect(host.querySelector('.agent-card')).toBe(card);
  expect(document.activeElement).toBe(card);
  expect(card.textContent).toContain('Running tests');
  expect(swatch()?.style.background).toBe('#0000ff');
  publish([{ ...agent, projectColor: undefined }]);
  expect(swatch()).toBeNull();
});

it('combines search with status filters and restores them when returning from a task', () => {
  const list: RemoteAgent[] = [
    {
      agentId: 'a1',
      taskId: 't1',
      taskName: 'Build feature',
      lastLine: '',
      agentName: 'Codex',
      status: 'running',
      attention: 'active',
      exitCode: null,
    },
    {
      agentId: 'a2',
      taskId: 't2',
      taskName: 'Fix login',
      lastLine: '',
      agentName: 'Claude',
      status: 'running',
      attention: 'needs_input',
      exitCode: null,
    },
    {
      agentId: 'a3',
      taskId: 't3',
      taskName: 'Review tests',
      lastLine: '',
      agentName: 'Codex',
      status: 'running',
      attention: 'review',
      exitCode: null,
    },
  ];
  const publish = () =>
    Socket.current.onmessage?.({ data: JSON.stringify({ type: 'agents', list }) });
  const mount = () => {
    dispose = render(
      () => <AgentList onSelect={() => {}} onNewTask={() => {}} onPair={() => {}} />,
      host,
    );
  };
  const click = (label: string) => {
    const button = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith(label),
    );
    if (!button) throw new Error(`Missing button: ${label}`);
    button.click();
  };
  publish();
  mount();
  const search = host.querySelector('input');
  if (!search) throw new Error('Missing search');
  search.value = 'Codex';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  expect(host.querySelectorAll('.agent-card')).toHaveLength(2);
  click('Review 1');
  expect(host.querySelectorAll('.agent-card')).toHaveLength(1);
  expect(host.querySelector('.agent-card')?.textContent).toContain('Review tests');
  dispose();
  mount();
  expect(host.querySelector('input')?.value).toBe('Codex');
  expect(host.querySelectorAll('.agent-card')).toHaveLength(1);
  list[2].attention = 'active';
  publish();
  expect(host.querySelectorAll('.agent-card')).toHaveLength(0);
  expect(host.textContent).toContain('No matching tasks');
  click('Show all tasks');
  expect(host.querySelector('input')?.value).toBe('');
  expect(host.querySelectorAll('.agent-card')).toHaveLength(3);
  const restoredSearch = host.querySelector('input');
  if (!restoredSearch) throw new Error('Missing search');
  restoredSearch.value = 'Codex';
  restoredSearch.dispatchEvent(new Event('input', { bubbles: true }));
  host.querySelector<HTMLButtonElement>('[aria-label="Clear search"]')?.click();
  expect(restoredSearch.value).toBe('');
  expect(document.activeElement).toBe(restoredSearch);
});
