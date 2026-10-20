import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import { RunComposer } from './RunComposer';
import { documentStore, setDocumentComposerDraft, type DocumentSelection } from './store';
import type { DocumentBlock } from './markdown-blocks';

vi.mock('./agent-task', () => ({
  sendToDocumentAgent: vi.fn(() => Promise.resolve()),
}));

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  setDocumentComposerDraft(null);
  setStore({ projects: [], availableAgents: [] });
});

const blocks: DocumentBlock[] = [
  {
    index: 0,
    type: 'paragraph',
    raw: 'Body text.\n',
    html: '<p>Body text.</p>',
    startLine: 1,
    endLine: 1,
  },
];

const passage: DocumentSelection = {
  startBlock: 0,
  endBlock: 0,
  startLine: 1,
  endLine: 1,
  quote: 'Body text.',
  heading: undefined,
  wholeDocument: false,
};

describe('RunComposer draft mode', () => {
  it('opens on the mode a hover action asked for', () => {
    setDocumentComposerDraft({ text: '', mode: 'note' });
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(() => <RunComposer selection={passage} blocks={blocks} onClose={() => {}} />, host),
    );

    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Add comment');
    expect(host.querySelector('[role="tablist"]')).toBeNull();
  });

  it('keeps the chosen action and closes from its corner', () => {
    const onClose = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(() => <RunComposer selection={passage} blocks={blocks} onClose={onClose} />, host),
    );

    expect(host.querySelector('.docws-composer-title')?.textContent).toBe('Rewrite');
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    host.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('has no passage to let go of when it acts on the whole document', () => {
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(() => <RunComposer selection={null} blocks={blocks} onClose={() => {}} />, host),
    );

    expect(host.querySelector('[aria-label="Close"]')).not.toBeNull();
    expect(host.textContent).toContain('Whole document');
  });
});

it('preserves note text and mode when the composer is remounted', () => {
  setDocumentComposerDraft({ text: '', mode: 'note' });
  const host = document.createElement('div');
  document.body.append(host);
  const dispose = render(
    () => <RunComposer selection={passage} blocks={blocks} onClose={() => {}} />,
    host,
  );
  const box = host.querySelector('textarea');
  if (!box) throw new Error('No note composer');
  box.value = 'Remember this.\nAnd this.';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  expect(documentStore.composerDraft).toMatchObject({ text: box.value, mode: 'note' });
  dispose();
  disposers.push(
    render(() => <RunComposer selection={passage} blocks={blocks} onClose={() => {}} />, host),
  );
  expect(host.querySelector('textarea')?.value).toBe('Remember this.\nAnd this.');
  expect(host.querySelector('textarea')?.getAttribute('aria-label')).toBe('Comment');
});
