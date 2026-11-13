import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { AgentList } from './AgentList';
import { connect, reconnect } from './ws';
import type { RemoteAgent } from '../../electron/remote/protocol';

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
  const card = host.querySelector<HTMLLIElement>('.agent-card');
  const open = card?.querySelector<HTMLButtonElement>('.agent-card-title');
  if (!card || !open) throw new Error('Missing task card');
  const swatch = () => card.querySelector<HTMLElement>('.project-swatch');
  expect(swatch()?.style.background).toBe('#ff0000');
  open.focus();
  publish([{ ...agent, lastLine: 'Running tests', projectColor: '#0000ff' }]);
  expect(host.querySelector('.agent-card')).toBe(card);
  expect(document.activeElement).toBe(open);
  expect(card.textContent).toContain('Running tests');
  expect(swatch()?.style.background).toBe('#0000ff');
  publish([{ ...agent, projectColor: '#0000ff', projectIcon: 'bug' }]);
  expect(swatch()?.style.color).toBe('#0000ff');
  expect(swatch()?.querySelector('svg')).not.toBeNull();
  publish([{ ...agent, projectColor: '#0000ff', projectIcon: 'not-an-icon' }]);
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
  click('Needs you 1');
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

it('points Android browsers to the app and leaves other phones alone', () => {
  const userAgent = vi.spyOn(navigator, 'userAgent', 'get');
  userAgent.mockReturnValue('Mozilla/5.0 (Linux; Android 15; Pixel 9)');
  dispose = render(
    () => <AgentList onSelect={() => {}} onNewTask={() => {}} onPair={() => {}} />,
    host,
  );
  const link = host.querySelector<HTMLAnchorElement>('.mobile-notifications a');
  expect(link?.href).toBe('https://github.com/johannesjo/parallel-code#android-app');
  dispose();

  userAgent.mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
  dispose = render(
    () => <AgentList onSelect={() => {}} onNewTask={() => {}} onPair={() => {}} />,
    host,
  );
  expect(host.textContent).not.toContain('Android app');
  userAgent.mockRestore();
});

it('groups tasks under the desktop board lanes and names a ready task by its checks', () => {
  const base = { status: 'running', exitCode: null, lastLine: '' } as const;
  const list: RemoteAgent[] = [
    {
      ...base,
      agentId: 'a1',
      taskId: 't1',
      taskName: 'Red PR',
      attention: 'idle',
      ci: 'failure',
      lane: 'needs',
    },
    {
      ...base,
      agentId: 'a4',
      taskId: 't4',
      taskName: 'Babysat PR',
      attention: 'idle',
      ci: 'failure',
      lane: 'pr',
    },
    {
      ...base,
      agentId: 'a2',
      taskId: 't2',
      taskName: 'Green work',
      attention: 'ready',
      ci: 'success',
      lane: 'stopped',
    },
    { ...base, agentId: 'a3', taskId: 't3', taskName: 'Question', attention: 'needs_input' },
    {
      ...base,
      agentId: 'a5',
      taskId: 't5',
      taskName: 'Merged work',
      attention: 'idle',
      lane: 'done',
    },
  ];
  Socket.current.onmessage?.({ data: JSON.stringify({ type: 'agents', list }) });
  dispose = render(
    () => <AgentList onSelect={() => {}} onNewTask={() => {}} onPair={() => {}} />,
    host,
  );
  const group = (name: string) => host.querySelector(`section[aria-label="${name}"]`);
  expect(group('Needs you')?.textContent).toContain('Red PR');
  expect(group('Needs you')?.textContent).toContain('CI failed');
  // Failed CI waits on no answer, so the card states it without an ask row.
  expect(group('Needs you')?.querySelector('.agent-ask')?.textContent).toBe('Needs inputAnswer');
  expect(group('Needs you')?.querySelectorAll('.agent-ask')).toHaveLength(1);
  expect(group('In pull request')?.textContent).toContain('Babysat PR');
  expect(group('Stopped')?.textContent).toContain('Green work');
  expect(group('Stopped')?.textContent).toContain('Ready to merge');
  expect(group('Done')?.textContent).toContain('Merged work');
  // Without a lane from the desktop, the phone still files a question under Needs you.
  expect(group('Needs you')?.textContent).toContain('Question');
  // The desktop leaves failed CI in its PR lane only while Babysit hands it to
  // the agent, so the phone does not count it as needing you either.
  expect(host.textContent).toContain('2 tasks need your attention');
  expect(group('In pull request')?.querySelector('.agent-ask')).toBeNull();
});

it("shows a task's PR row like the board card, without repeating its checks in the status", () => {
  const base = { status: 'running', exitCode: null, lastLine: '', lane: 'pr' } as const;
  const list: RemoteAgent[] = [
    {
      ...base,
      agentId: 'a1',
      taskId: 't1',
      taskName: 'Red PR',
      attention: 'idle',
      ci: 'failure',
      pr: {
        url: 'https://github.com/o/r/pull/42',
        label: 'CI failed',
        kind: 'failed',
        babysit: true,
      },
    },
    { ...base, agentId: 'a2', taskId: 't2', taskName: 'No PR', attention: 'idle' },
  ];
  Socket.current.onmessage?.({ data: JSON.stringify({ type: 'agents', list }) });
  dispose = render(
    () => <AgentList onSelect={() => {}} onNewTask={() => {}} onPair={() => {}} />,
    host,
  );
  const [red, plain] = host.querySelectorAll('.agent-card');
  const row = red?.querySelector('.agent-pr');
  expect(row?.textContent).toContain('PR #42');
  expect(row?.textContent).toContain('CI failed');
  expect(row?.textContent).toContain('Babysitting');
  expect(row?.classList.contains('failed')).toBe(true);
  expect(red?.querySelector('.agent-status')?.textContent).not.toContain('CI failed');
  // Babysit hands the failure to the agent, so the card does not ask for the user.
  expect(red?.querySelector('.agent-ask')).toBeNull();
  expect(plain?.querySelector('.agent-pr')).toBeNull();
});

it('keeps the main lanes in place when empty and folds snoozed work like the desktop board', () => {
  const base = { status: 'running', exitCode: null, lastLine: '' } as const;
  const list: RemoteAgent[] = [
    {
      ...base,
      agentId: 'a1',
      taskId: 't1',
      taskName: 'Busy',
      attention: 'active',
      lane: 'working',
    },
    {
      ...base,
      agentId: 'a2',
      taskId: 't2',
      taskName: 'Parked',
      attention: 'idle',
      collapsed: true,
      lane: 'snoozed',
    },
  ];
  Socket.current.onmessage?.({ data: JSON.stringify({ type: 'agents', list }) });
  const mount = () => {
    dispose = render(
      () => <AgentList onSelect={() => {}} onNewTask={() => {}} onPair={() => {}} />,
      host,
    );
  };
  mount();
  const group = (name: string) => host.querySelector(`section[aria-label="${name}"]`);
  for (const name of ['Needs you', 'Stopped', 'In pull request'])
    expect(group(name)?.classList.contains('empty'), name).toBe(true);
  expect(group('Ready to merge')).toBeNull();
  expect(group('Done')).toBeNull();
  // Snoozed starts folded: its count shows, its cards do not.
  const toggle = group('Snoozed & minimized')?.querySelector<HTMLButtonElement>('button');
  expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  expect(toggle?.textContent).toContain('1');
  expect(host.textContent).not.toContain('Parked');
  toggle?.click();
  expect(host.textContent).toContain('Parked');
  // The choice survives returning from a task.
  dispose();
  mount();
  expect(host.textContent).toContain('Parked');
  // Searching shows only the lanes with matches, and opens a folded snoozed lane.
  dispose();
  localStorage.removeItem('parallel-mobile:snoozed-open');
  mount();
  const search = host.querySelector('input');
  if (!search) throw new Error('Missing search');
  search.value = 'Parked';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  expect(group('Needs you')).toBeNull();
  expect(host.textContent).toContain('Parked');
  expect(group('Snoozed & minimized')?.querySelector('button')?.disabled).toBe(true);
  search.value = '';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  expect(host.textContent).not.toContain('Parked');
  // A filter shows only the lanes that hold its tasks.
  [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Stopped'))?.click();
  expect(group('Stopped')).toBeNull();
  expect(host.textContent).toContain('No stopped tasks');
});

it("offers a waiting task the desktop card's ask action, which opens it", () => {
  const base = { status: 'running', exitCode: null, lastLine: '' } as const;
  const list: RemoteAgent[] = [
    { ...base, agentId: 'a1', taskId: 't1', taskName: 'Question', attention: 'needs_input' },
    { ...base, agentId: 'a2', taskId: 't2', taskName: 'Broken', attention: 'error' },
    { ...base, agentId: 'a3', taskId: 't3', taskName: 'Busy', attention: 'active' },
  ];
  Socket.current.onmessage?.({ data: JSON.stringify({ type: 'agents', list }) });
  const opened: string[] = [];
  dispose = render(
    () => <AgentList onSelect={(id) => opened.push(id)} onNewTask={() => {}} onPair={() => {}} />,
    host,
  );
  const card = (name: string) =>
    [...host.querySelectorAll('.agent-card')].find((c) => c.textContent?.includes(name));
  const ask = (name: string) => card(name)?.querySelector('.agent-ask');
  expect(ask('Question')?.textContent).toBe('Needs inputAnswer');
  expect(ask('Broken')?.textContent).toBe('ErrorShow error');
  expect(card('Broken')?.classList.contains('failed')).toBe(true);
  expect(ask('Busy')).toBeNull();
  expect(card('Busy')?.querySelector('.agent-status')?.textContent).toBe('Working');
  ask('Question')?.querySelector('button')?.click();
  card('Busy')?.querySelector<HTMLButtonElement>('.agent-card-title')?.click();
  expect(opened).toEqual(['t1', 't3']);
});
