import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import { RunComposer } from './RunComposer';
import type { DocumentBlock } from './markdown-blocks';
import { setDocumentComposerDraft, dispatchDocumentRun, type DocumentSelection } from './store';
import { sendToDocumentAgent } from './agent-task';

// The composer reads the open project from the store; pin it without opening a workspace.
vi.mock('./store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store')>();
  return {
    ...actual,
    dispatchDocumentRun: vi.fn(() => Promise.resolve(null)),
    documentStore: new Proxy(actual.documentStore, {
      get: (target, key) => (key === 'projectId' ? 'docs' : Reflect.get(target, key)),
    }),
  };
});

vi.mock('./agent-task', () => ({
  sendToDocumentAgent: vi.fn(() => Promise.resolve()),
}));

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  setStore({ projects: [], availableAgents: [] });
  setDocumentComposerDraft(null);
  vi.clearAllMocks();
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

const agentDef = (id: string, name: string) => ({
  id,
  name,
  command: id,
  args: [],
  resume_args: [],
  skip_permissions_args: [],
  description: '',
});

function click(host: HTMLElement, label: string, group?: string) {
  const root = group ? host.querySelector(`[aria-label="${group}"]`) : host;
  const target = Array.from(root?.querySelectorAll('button') ?? []).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!target) throw new Error(`No ${label} button`);
  target.click();
  return target;
}

function directEditing(host: HTMLElement) {
  click(host, 'Apply directly');
}

function type(host: HTMLElement, text: string) {
  const box = host.querySelector('textarea');
  if (!box) throw new Error('No textarea');
  box.value = text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return box;
}

describe('RunComposer', () => {
  it('keeps "Send to agent" off while no agent is installed', () => {
    const host = mount(passage);
    directEditing(host);
    const box = host.querySelector('textarea');
    if (box) {
      box.value = 'Tighten this.';
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const send = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Rewrite',
    );

    expect(send?.disabled).toBe(true);
    expect(send?.title).toBe('No agent is installed.');

    // No workspace is open here, so the button stays off; the reason goes away.
    setStore('availableAgents', [agentDef('codex', 'Codex')]);
    expect(send?.title).toBe('');
  });

  it('starts with review and keeps agent configuration in Options', () => {
    const host = mount(passage);
    expect(host.querySelector('.docws-composer-title')?.textContent).toBe('Rewrite');
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    const options = host.querySelector('details');
    expect(options?.open).toBe(false);
    expect(host.querySelector('[aria-label="Agents"]')).toBeNull();
    const review = click(host, 'Review first', 'After rewriting');
    expect(review.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('[aria-label="Alternatives"]')).not.toBeNull();
    directEditing(host);
    expect(host.textContent).toContain('Edits the document directly.');
    expect(host.querySelector('[aria-label="Alternatives"]')).toBeNull();
    expect(host.querySelector('details')).toBeNull();
  });

  it('counts candidates against the maximum in the plural', () => {
    setStore('availableAgents', [agentDef('claude-code', 'Claude Code')]);
    const host = mount(passage);
    click(host, '2', 'Alternatives');
    expect(host.querySelector('.docws-proposal-count')?.textContent).toBe('2 of 6 candidates');
  });

  it('sends to the interactive agent when applying directly, on Rewrite and Enter', async () => {
    setStore('projects', [
      {
        id: 'docs',
        name: 'Docs',
        path: '/docs',
        color: '',
        kind: 'document',
        documentPath: 'a.md',
      },
    ]);
    setStore('availableAgents', [agentDef('claude-code', 'Claude Code')]);
    const host = mount(passage);
    directEditing(host);
    const box = type(host, 'Tighten this.');
    click(host, 'Rewrite');
    await vi.waitFor(() => expect(sendToDocumentAgent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(sendToDocumentAgent).mock.calls[0][1]).toContain('Tighten this.');
    expect(dispatchDocumentRun).not.toHaveBeenCalled();

    type(host, 'Again.');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(sendToDocumentAgent).toHaveBeenCalledTimes(2));
  });

  it('starts a multi-candidate run when reviewing first with two alternatives', async () => {
    setStore('projects', [
      {
        id: 'docs',
        name: 'Docs',
        path: '/docs',
        color: '',
        kind: 'document',
        documentPath: 'a.md',
      },
    ]);
    setStore('availableAgents', [
      agentDef('claude-code', 'Claude Code'),
      agentDef('codex', 'Codex'),
    ]);
    const host = mount(passage);
    click(host, '2', 'Alternatives');
    type(host, 'Tighten this.');
    click(host, 'Rewrite');
    await vi.waitFor(() => expect(dispatchDocumentRun).toHaveBeenCalledTimes(1));
    const picks = vi.mocked(dispatchDocumentRun).mock.calls[0][1];
    expect(picks.reduce((n, p) => n + p.count, 0)).toBe(2);
    expect(sendToDocumentAgent).not.toHaveBeenCalled();
  });

  it('acts on the whole document when nothing is picked and keeps notes to passages', () => {
    const host = mount(null);

    expect(host.textContent).toContain('Whole document');
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

  it('quotes the picked passage for a rewrite', () => {
    const host = mount(passage);

    expect(host.querySelector('.docws-composer-quote')?.textContent).toBe('Body text.');
  });
});
