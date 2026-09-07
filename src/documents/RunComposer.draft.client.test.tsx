import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import { BLOCK_ACTIONS } from './BlockActions';
import { RunComposer } from './RunComposer';
import { setDocumentComposerDraft, type DocumentSelection } from './store';
import type { DocumentBlock } from './markdown-blocks';

vi.mock('./agent-terminal', () => ({
  documentAgentPtyId: (id: string) => `doc-agent-${id}`,
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
    setDocumentComposerDraft({ text: '', mode: 'question' });
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(() => <RunComposer selection={passage} blocks={blocks} onClose={() => {}} />, host),
    );

    const selected = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (t) => t.getAttribute('aria-selected') === 'true',
    );
    expect(selected?.textContent).toBe('Ask');
  });

  it('carries the hover icons on its tabs and lets go of the passage from its corner', () => {
    const onClose = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(() => <RunComposer selection={passage} blocks={blocks} onClose={onClose} />, host),
    );

    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    // Same glyphs in the same order as the block toolbar, minus its pencil.
    expect(tabs.map((t) => t.querySelector('path')?.getAttribute('d'))).toEqual(
      BLOCK_ACTIONS.filter((a) => a.kind !== 'edit').map((a) => a.path),
    );

    host.querySelector<HTMLButtonElement>('[aria-label="Clear the passage"]')?.click();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('has no passage to let go of when it acts on the whole document', () => {
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(() => <RunComposer selection={null} blocks={blocks} onClose={() => {}} />, host),
    );

    expect(host.querySelector('[aria-label="Clear the passage"]')).toBeNull();
    expect(host.textContent).toContain('Whole document');
  });
});
