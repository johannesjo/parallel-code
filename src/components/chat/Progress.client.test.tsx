import { render } from 'solid-js/web';
import { createStore } from 'solid-js/store';
import { afterEach, expect, it } from 'vitest';
import type { AgentChatState } from '../../../electron/shared/agent-chat-types';
import { Progress } from './Progress';

let dispose = () => {};
afterEach(() => {
  dispose();
  document.body.replaceChildren();
});

it('announces what the agent is doing without re-announcing the ticking clock', () => {
  const container = document.createElement('div');
  document.body.append(container);
  // Built once: an inline prop object is a getter in Solid, so it would re-read the
  // clock after the component sampled it.
  const state = {
    status: 'working' as const,
    items: [],
    requests: [],
    startedAt: Date.now() - 65_500,
  };
  dispose = render(() => <Progress state={state} />, container);
  const status = container.querySelector('[role="status"]');
  expect(status?.textContent).toBe('Working…');
  expect(status?.querySelector('time')).toBeNull();
  expect(container.querySelector('time')?.textContent).toBe('1:05');
});

it('keeps a status row across working, waiting, completed and disconnected turns', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const [state, setState] = createStore<AgentChatState>({
    status: 'ready',
    items: [],
    requests: [],
  });
  dispose = render(() => <Progress state={state} />, container);
  const row = container.querySelector('.chat-progress');
  expect(row).not.toBeNull();
  expect(row?.textContent).toBe('');

  setState('status', 'working');
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Working…');
  expect(container.querySelector('.inline-spinner')).not.toBeNull();

  setState('items', [
    {
      id: 'tool',
      kind: 'tool',
      text: '',
      activity: { type: 'command', label: 'npm test', status: 'running' },
    },
  ]);
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Working… · npm test');

  setState('requests', [{ id: 'r1', since: 1, kind: 'approval', text: 'Run tests?' }]);
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Waiting for your input');
  expect(container.querySelector('.inline-spinner')).toBeNull();

  setState('requests', []);
  expect(container.querySelector('.inline-spinner')).not.toBeNull();
  setState('items', []);
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Working…');

  for (const status of ['ready', 'closed'] as const) {
    setState('status', status);
    expect(container.querySelector('.chat-progress')).toBe(row);
    expect(row?.textContent).toBe('');
    expect(container.querySelector('.inline-spinner')).toBeNull();
  }

  setState('interrupted', true);
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Response stopped');
  expect(container.querySelector('.inline-spinner')).toBeNull();
});
