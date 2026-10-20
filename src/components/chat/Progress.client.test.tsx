import { render } from 'solid-js/web';
import { afterEach, expect, it } from 'vitest';
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

it('spins only while the agent works, not while it waits for input', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const state = { status: 'working' as const, items: [], requests: [] as never[] };
  dispose = render(() => <Progress state={state} />, container);
  expect(container.querySelector('.inline-spinner')).not.toBeNull();
  dispose();

  const waiting = { ...state, requests: [{ id: 'r1' }] as never[] };
  dispose = render(() => <Progress state={waiting} />, container);
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Waiting for your input');
  expect(container.querySelector('.inline-spinner')).toBeNull();
});
