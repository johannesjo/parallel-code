import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { TranscriptSearch } from './TranscriptSearch';
import type { ChatItem } from '../../../electron/shared/agent-chat-types';

let container: HTMLDivElement;
let dispose: () => void;
let setItems: (items: ChatItem[]) => void;
let scanned = 0;

/** An entry that counts how often search reads it. */
const entry = (id: string, text: string): ChatItem => ({
  id,
  kind: 'assistant',
  get text() {
    scanned++;
    return text;
  },
});
const toggle = () =>
  [...container.querySelectorAll('button')]
    .find((node) => node.textContent === 'Search conversation')
    ?.click();
const results = () => container.querySelectorAll('.chat-search-results button').length;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  scanned = 0;
  container = document.createElement('div');
  document.body.append(container);
  const [items, set] = createSignal<ChatItem[]>([entry('a', 'the needle')]);
  setItems = set;
  dispose = render(() => <TranscriptSearch items={items()} onJump={() => {}} />, container);
});
afterEach(() => {
  dispose();
  container.remove();
});

it('stops rescanning streamed output once closed, and picks the query back up on reopening', async () => {
  toggle();
  await settle();
  const input = container.querySelector<HTMLInputElement>('[aria-label="Search conversation"]');
  if (!input) throw new Error('search input missing');
  input.value = 'needle';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(results()).toBe(1);

  toggle();
  scanned = 0;
  setItems([entry('a', 'the needle'), entry('b', 'another needle')]);
  expect(scanned).toBe(0);

  toggle();
  await settle();
  expect(container.querySelector<HTMLInputElement>('input')?.value).toBe('needle');
  expect(results()).toBe(2);
});
