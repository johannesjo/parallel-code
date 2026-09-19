import { render } from 'solid-js/web';
import { createStore, reconcile } from 'solid-js/store';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ContextMeter } from './ContextMeter';
import type { AgentChatState } from '../../../electron/shared/agent-chat-types';

let container: HTMLDivElement;
let dispose: (() => void) | undefined;
let setState: (state: AgentChatState) => void;
const base: AgentChatState = { status: 'ready', items: [], requests: [] };
const meter = () => container.querySelector<HTMLElement>('[role="meter"]');

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  const [state, set] = createStore<AgentChatState>({ ...base });
  setState = (next) => set(reconcile(next));
  dispose = render(() => <ContextMeter state={state} />, container);
});
afterEach(() => {
  dispose?.();
  container.remove();
});

// Exact counts are formatted in the host's locale, so the expected text is too.
const n = (value: number) => value.toLocaleString();

it('shows how full the context is, with exact figures and over-limit usage on hover', () => {
  expect(meter()).toBeNull();
  setState({ ...base, contextUsage: { usedTokens: 50000, maxTokens: 200000 } });
  // A ring alone until the window runs short; the figures wait on hover.
  expect(meter()?.textContent).toBe('');
  expect(meter()?.title).toContain(`${n(50_000)} of ${n(200_000)} tokens used, 150K left`);
  expect(meter()?.getAttribute('aria-valuenow')).toBe('50000');
  setState({ ...base, contextUsage: { usedTokens: 190000, maxTokens: 200000 } });
  expect(meter()?.dataset.level).toBe('high');
  expect(meter()?.textContent).toBe('95%');
  setState({ ...base, contextUsage: { usedTokens: 210000, maxTokens: 200000 } });
  expect(meter()?.textContent).toBe('105%');
  expect(meter()?.dataset.level).toBe('full');
  expect(meter()?.getAttribute('aria-valuenow')).toBe('200000');
  expect(meter()?.getAttribute('aria-valuetext')).toContain(`${n(210_000)} of ${n(200_000)}`);
  setState(base);
  expect(meter()).toBeNull();
});

it('adds the session token breakdown to the hover text', () => {
  const contextUsage = { usedTokens: 0, maxTokens: 200000 };
  setState({ ...base, contextUsage });
  expect(meter()?.title).not.toContain('Session');
  setState({
    ...base,
    contextUsage,
    tokenUsage: {
      totalTokens: 12500,
      inputTokens: 12000,
      outputTokens: 500,
      scope: 'conversation',
    },
  });
  expect(meter()?.title).toContain(`Session: ${n(12_500)} tokens · ${n(12_000)} input`);
  expect(meter()?.title).toContain('for this conversation');
  setState({
    ...base,
    contextUsage,
    tokenUsage: { totalTokens: 0, inputTokens: 0, outputTokens: 0, scope: 'connection' },
  });
  expect(meter()?.title).toContain('since this chat connected');
});
