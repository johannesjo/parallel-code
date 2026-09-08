import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import { RunComposer } from './RunComposer';
import type { DocumentBlock } from './markdown-blocks';
import type { DocumentSelection } from './store';

vi.mock('./agent-task', () => ({
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
  it('keeps "Send to agent" off while no agent is installed', () => {
    const host = mount(passage);
    tab(host, 'Edit with agent')?.click();
    const box = host.querySelector('textarea');
    if (box) {
      box.value = 'Tighten this.';
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const send = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Send to agent',
    );

    expect(send?.disabled).toBe(true);
    expect(send?.title).toBe('No agent is installed.');

    // No workspace is open here, so the button stays off; the reason goes away.
    setStore('availableAgents', [
      {
        id: 'codex',
        name: 'Codex',
        command: 'codex',
        args: [],
        resume_args: [],
        skip_permissions_args: [],
        description: '',
      },
    ]);
    expect(send?.title).toBe('');
  });

  it('defaults to proposals and makes direct editing an explicit choice', () => {
    const host = mount(passage);

    const task = tab(host, 'Edit with agent');
    const proposals = tab(host, 'Proposals');
    expect(proposals?.getAttribute('aria-selected')).toBe('true');
    expect(task?.getAttribute('aria-selected')).toBe('false');
    // Who drafts is the decision, so the agents sit in plain view; tuning is folded away.
    const agents = host.querySelector('[aria-label="Agents"]');
    expect(agents).not.toBeNull();
    const options = host.querySelector('details');
    expect(options).not.toBeNull();
    expect(options?.open).toBe(false);
    expect(options?.contains(agents)).toBe(false);
    expect(options?.textContent).toContain('Models and main session');
    expect(host.querySelector('.docws-proposal-count')?.textContent).toMatch(
      /^\d+ of \d+ candidates?$/,
    );
    expect(host.textContent).toContain('Your document changes only when you accept a proposal.');
    // No second toggle: the run target is one of the modes now.
    expect(host.querySelectorAll('[role="radio"]')).toHaveLength(0);

    task?.click();
    expect(task?.getAttribute('aria-selected')).toBe('true');
    expect(proposals?.getAttribute('aria-selected')).toBe('false');
    expect(host.textContent).toContain('The agent edits your document directly.');
    expect(host.querySelector('[aria-label="Agents"]')).toBeNull();
  });

  it('counts candidates against the maximum in the plural', () => {
    setStore('availableAgents', [
      {
        id: 'claude-code',
        name: 'Claude Code',
        command: 'claude',
        args: [],
        resume_args: [],
        skip_permissions_args: [],
        description: '',
      },
    ]);
    const host = mount(passage);
    expect(host.querySelector('.docws-proposal-count')?.textContent).toBe('1 of 6 candidates');
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
