import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import { RunComposer } from './RunComposer';
import type { DocumentBlock } from './markdown-blocks';
import type { DocumentSelection } from './store';

vi.mock('./agent-terminal', () => ({
  documentAgentPtyId: (id: string) => `doc-agent-${id}`,
  sendToDocumentAgent: vi.fn(() => Promise.resolve()),
}));

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  setStore({ projects: [], availableAgents: [] });
});

const blocks: DocumentBlock[] = [
  {
    index: 0,
    type: 'paragraph',
    raw: '# Title\n',
    html: '<h1>Title</h1>',
    startLine: 1,
    endLine: 1,
    headingLevel: 1,
    headingText: 'Title',
  },
  {
    index: 1,
    type: 'paragraph',
    raw: 'Body text.\n',
    html: '<p>Body text.</p>',
    startLine: 3,
    endLine: 3,
  },
];

const passage: DocumentSelection = {
  startBlock: 1,
  endBlock: 1,
  startLine: 3,
  endLine: 3,
  quote: 'Body text.',
  heading: 'Title',
  wholeDocument: false,
};

function mount(selection: DocumentSelection | null) {
  const host = document.createElement('div');
  document.body.append(host);
  disposers.push(
    render(() => <RunComposer selection={selection} blocks={blocks} onClose={() => {}} />, host),
  );
  return host;
}

function tab(host: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (b) => b.textContent?.trim() === label,
    ) ?? null
  );
}

describe('RunComposer', () => {
  it('runs a task in the session and puts proposals on their own tab', () => {
    const host = mount(passage);

    const task = tab(host, 'Task');
    const proposals = tab(host, 'Proposals');
    expect(task?.getAttribute('aria-selected')).toBe('true');
    expect(proposals?.getAttribute('aria-selected')).toBe('false');
    expect(host.textContent).toContain('The agent edits your document directly.');
    expect(host.querySelector<HTMLElement>('[aria-label="Agents"]')?.style.display).toBe('none');

    proposals?.click();

    expect(task?.getAttribute('aria-selected')).toBe('false');
    expect(proposals?.getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector<HTMLElement>('[aria-label="Agents"]')?.style.display).toBe('');
    const options = host.querySelector('details');
    expect(options).not.toBeNull();
    expect(options?.open).toBe(false);
    expect(options?.contains(host.querySelector('[aria-label="Agents"]'))).toBe(true);
    expect(host.textContent).toContain('Your document changes only when you accept a proposal.');
    // No second toggle: the run target is one of the modes now.
    expect(host.querySelectorAll('[role="radio"]')).toHaveLength(0);
  });

  it('keeps proposals reachable with nothing picked, unlike notes and questions', () => {
    const host = mount(null);

    expect(tab(host, 'Proposals')?.disabled).toBe(false);
    expect(tab(host, 'Note')?.disabled).toBe(true);
  });

  it('acts on the whole document when nothing is picked and keeps notes to passages', () => {
    const host = mount(null);

    expect(host.textContent).toContain('Whole document');
    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs.find((t) => t.textContent === 'Note')?.disabled).toBe(true);
    expect(tabs.find((t) => t.textContent === 'Ask')?.disabled).toBe(true);
    expect(host.querySelector('.docws-composer-quote')).toBeNull();
  });

  it('opens at full strength on a passage and steps back once focus leaves', () => {
    const host = mount(passage);
    const composer = host.querySelector<HTMLElement>('.docws-composer');
    expect(composer?.classList.contains('is-fresh')).toBe(true);

    const outside = document.createElement('button');
    document.body.append(outside);
    composer?.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outside }));

    expect(composer?.classList.contains('is-fresh')).toBe(false);
  });

  it('quotes the picked passage and lets notes attach to it', () => {
    const host = mount(passage);

    expect(host.querySelector('.docws-composer-quote')?.textContent).toBe('Body text.');
    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs.find((t) => t.textContent === 'Note')?.disabled).toBe(false);
  });
});
