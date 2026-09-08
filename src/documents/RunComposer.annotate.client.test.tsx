import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import { RunComposer } from './RunComposer';
import type { DocumentBlock } from './markdown-blocks';
import type { DocumentSelection } from './store';

const { addDocumentAnnotation } = vi.hoisted(() => ({
  addDocumentAnnotation: vi.fn(async () => ({ id: 'saved-1' })),
}));

vi.mock('./agent-task', () => ({
  sendToDocumentAgent: vi.fn(() => Promise.resolve()),
}));

vi.mock('./store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store')>()),
  addDocumentAnnotation,
}));

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  setStore({ projects: [], availableAgents: [] });
  vi.clearAllMocks();
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

function tab(host: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
    (t) => t.textContent?.trim() === label,
  );
}

function type(host: HTMLElement, text: string): HTMLTextAreaElement {
  const textarea = host.querySelector('textarea') as HTMLTextAreaElement;
  textarea.value = text;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  return textarea;
}

function pressEnter(textarea: HTMLTextAreaElement): void {
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

describe('RunComposer while an input method is composing', () => {
  it('leaves Enter to the IME instead of saving a half-typed note', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(() => <RunComposer selection={passage} blocks={blocks} onClose={() => {}} />, host),
    );
    tab(host, 'Note')?.click();
    const textarea = type(host, '注意');

    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }),
    );
    await Promise.resolve();
    expect(addDocumentAnnotation).not.toHaveBeenCalled();

    pressEnter(textarea);
    await vi.waitFor(() => expect(addDocumentAnnotation).toHaveBeenCalledOnce());
  });
});

describe('RunComposer after a note or question is saved', () => {
  it('empties the instruction so the next passage opens on a blank composer', async () => {
    const onClose = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(() => <RunComposer selection={passage} blocks={blocks} onClose={onClose} />, host),
    );

    tab(host, 'Ask')?.click();
    const textarea = type(host, 'Why is this here?');
    pressEnter(textarea);
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());

    expect(addDocumentAnnotation).toHaveBeenCalledWith(
      'question',
      'Why is this here?',
      expect.anything(),
      { askWith: undefined },
    );
    expect(textarea.value).toBe('');
  });

  it('empties the instruction for a saved note too', async () => {
    const onClose = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(() => <RunComposer selection={passage} blocks={blocks} onClose={onClose} />, host),
    );

    tab(host, 'Note')?.click();
    const textarea = type(host, 'Revisit this paragraph.');
    pressEnter(textarea);
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());

    expect(textarea.value).toBe('');
  });

  it('keeps the text when saving failed, so nothing typed is lost', async () => {
    addDocumentAnnotation.mockResolvedValueOnce(null as never);
    const onClose = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(() => <RunComposer selection={passage} blocks={blocks} onClose={onClose} />, host),
    );

    tab(host, 'Ask')?.click();
    const textarea = type(host, 'Why is this here?');
    pressEnter(textarea);
    await vi.waitFor(() => expect(addDocumentAnnotation).toHaveBeenCalled());

    expect(onClose).not.toHaveBeenCalled();
    expect(textarea.value).toBe('Why is this here?');
  });
});
