import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import { RunComposer } from './RunComposer';
import type { DocumentBlock } from './markdown-blocks';
import { setDocumentComposerDraft, type DocumentSelection } from './store';
import { workspaceUi, resetWorkspaceUi } from './workspace-ui';

const { addDocumentAnnotation, saveDocumentNoteDraft } = vi.hoisted(() => ({
  addDocumentAnnotation: vi.fn(async () => ({ id: 'saved-1' })),
  saveDocumentNoteDraft: vi.fn(async () => {
    setDocumentComposerDraft(null);
    return true;
  }),
}));

vi.mock('./agent-task', () => ({
  sendToDocumentAgent: vi.fn(() => Promise.resolve()),
}));

vi.mock('./store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store')>()),
  addDocumentAnnotation,
  saveDocumentNoteDraft,
}));

const disposers: Array<() => void> = [];

beforeEach(() => {
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
});

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  setStore({ projects: [], availableAgents: [] });
  setDocumentComposerDraft(null);
  resetWorkspaceUi();
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

function type(host: HTMLElement, text: string): HTMLTextAreaElement {
  const textarea = host.querySelector('textarea') as HTMLTextAreaElement;
  textarea.value = text;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  return textarea;
}

function askButton(host: HTMLElement): HTMLButtonElement | null {
  return (
    Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Ask') ?? null
  );
}

function pressEnter(textarea: HTMLTextAreaElement, ctrlKey = false): void {
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ctrlKey }));
}

describe('RunComposer while an input method is composing', () => {
  it('leaves Enter to the IME instead of saving a half-typed note', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(() => <RunComposer selection={passage} blocks={blocks} onClose={() => {}} />, host),
    );
    setDocumentComposerDraft({ text: '', mode: 'note' });
    const textarea = type(host, '注意');

    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }),
    );
    await Promise.resolve();
    expect(saveDocumentNoteDraft).not.toHaveBeenCalled();

    pressEnter(textarea);
    expect(saveDocumentNoteDraft).not.toHaveBeenCalled();
    pressEnter(textarea, true);
    await vi.waitFor(() => expect(saveDocumentNoteDraft).toHaveBeenCalledOnce());
  });
});

describe('RunComposer after a comment or question is saved', () => {
  it('asks an agent from the Ask composer and drops a comment draft it took over', async () => {
    const onClose = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(() => <RunComposer selection={passage} blocks={blocks} onClose={onClose} />, host),
    );

    setDocumentComposerDraft({ text: '', mode: 'question' });
    const textarea = type(host, 'Why is this here?');
    askButton(host)?.click();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());

    expect(addDocumentAnnotation).toHaveBeenCalledWith(
      'question',
      'Why is this here?',
      expect.anything(),
      { askWith: expect.objectContaining({ id: 'codex' }) },
    );
    // The comment is not also autosaved on the way out.
    expect(saveDocumentNoteDraft).not.toHaveBeenCalled();
    expect(textarea.value).toBe('');
    expect(workspaceUi.focusedAnnotationId).toBe('saved-1');
  });

  it('keeps Ask off until there is text for it', () => {
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(() => <RunComposer selection={passage} blocks={blocks} onClose={() => {}} />, host),
    );
    setDocumentComposerDraft({ text: '', mode: 'question' });

    expect(askButton(host)?.disabled).toBe(true);
    type(host, 'Why?');
    expect(askButton(host)?.disabled).toBe(false);
  });

  it('saves a comment with the existing shortcut and offers no Ask beside it', async () => {
    const onClose = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(() => <RunComposer selection={passage} blocks={blocks} onClose={onClose} />, host),
    );

    setDocumentComposerDraft({ text: '', mode: 'note' });
    const textarea = type(host, 'Revisit this paragraph.');
    expect(host.querySelector('details')).toBeNull();
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(host.querySelector('.docws-composer-quote')).toBeNull();
    expect(host.querySelector('.docws-composer-scope')).toBeNull();
    // Retry only holds its place until a save fails.
    expect(Array.from(host.querySelectorAll('button')).map((b) => b.textContent?.trim())).toEqual([
      'Retry',
      '',
    ]);
    pressEnter(textarea, true);
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());

    expect(saveDocumentNoteDraft).toHaveBeenCalledOnce();
    expect(addDocumentAnnotation).not.toHaveBeenCalled();
  });

  it('closes an empty comment on a click outside it, and not on one inside', () => {
    const onClose = vi.fn();
    const host = document.createElement('div');
    const outside = document.createElement('p');
    document.body.append(host, outside);
    disposers.push(
      render(() => <RunComposer selection={passage} blocks={blocks} onClose={onClose} />, host),
    );
    setDocumentComposerDraft({ text: '', mode: 'note' });

    host.querySelector('textarea')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();

    outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(saveDocumentNoteDraft).not.toHaveBeenCalled();
  });

  it('closes a written comment at once on a click outside it and saves it behind', () => {
    const onClose = vi.fn();
    const host = document.createElement('div');
    const outside = document.createElement('p');
    document.body.append(host, outside);
    disposers.push(
      render(() => <RunComposer selection={passage} blocks={blocks} onClose={onClose} />, host),
    );
    setDocumentComposerDraft({ text: '', mode: 'note' });
    type(host, 'Tighten this.');

    outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(saveDocumentNoteDraft).toHaveBeenCalledOnce();
  });

  it('keeps a comment open for a press that keeps focus in it, or with no passage yet', () => {
    const onClose = vi.fn();
    const [picked, setPicked] = createSignal<DocumentSelection | null>(passage);
    const host = document.createElement('div');
    const outside = document.createElement('button');
    outside.addEventListener('mousedown', (e) => e.preventDefault());
    document.body.append(host, outside);
    disposers.push(
      render(() => <RunComposer selection={picked()} blocks={blocks} onClose={onClose} />, host),
    );
    setDocumentComposerDraft({ text: '', mode: 'note' });

    outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    setPicked(null);
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes a comment on Escape from its buttons, not only from the field', () => {
    const onClose = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(() => <RunComposer selection={passage} blocks={blocks} onClose={onClose} />, host),
    );
    setDocumentComposerDraft({ text: '', mode: 'note' });

    host
      .querySelector('[aria-label="Close"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows Retry and gives the field its focus back after a failed save', () => {
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(() => <RunComposer selection={passage} blocks={blocks} onClose={() => {}} />, host),
    );
    setDocumentComposerDraft({ text: 'Tighten this.', mode: 'note' });
    const retry = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Retry',
    );
    expect(retry?.style.visibility).toBe('hidden');
    (document.activeElement as HTMLElement | null)?.blur();

    setDocumentComposerDraft({ text: 'Tighten this.', mode: 'note', noteSaveStatus: 'error' });

    expect(retry?.style.visibility).toBe('visible');
    expect(document.activeElement).toBe(host.querySelector('textarea'));
  });

  it('makes room in the field for a failed save notice', () => {
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(() => <RunComposer selection={passage} blocks={blocks} onClose={() => {}} />, host),
    );
    setDocumentComposerDraft({ text: 'Tighten this.', mode: 'note' });
    const composer = host.querySelector('.docws-composer');
    expect(composer?.classList.contains('has-note-status')).toBe(false);

    setDocumentComposerDraft({ text: 'Tighten this.', mode: 'note', noteSaveStatus: 'error' });

    // The CSS widens the field's right padding so the notice covers no text.
    expect(composer?.classList.contains('has-note-status')).toBe(true);
  });

  it('keeps a rewrite open on a click outside it', () => {
    const onClose = vi.fn();
    const host = document.createElement('div');
    const outside = document.createElement('p');
    document.body.append(host, outside);
    disposers.push(
      render(() => <RunComposer selection={passage} blocks={blocks} onClose={onClose} />, host),
    );
    setDocumentComposerDraft({ text: '', mode: 'proposals' });

    outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps the text when saving failed, so nothing typed is lost', async () => {
    addDocumentAnnotation.mockResolvedValueOnce(null as never);
    const onClose = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(() => <RunComposer selection={passage} blocks={blocks} onClose={onClose} />, host),
    );

    setDocumentComposerDraft({ text: '', mode: 'question' });
    const textarea = type(host, 'Why is this here?');
    askButton(host)?.click();
    await vi.waitFor(() => expect(addDocumentAnnotation).toHaveBeenCalled());

    expect(onClose).not.toHaveBeenCalled();
    expect(textarea.value).toBe('Why is this here?');
  });

  it('sends a question with the save shortcut and never autosaves it as a comment', async () => {
    const onClose = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(() => <RunComposer selection={passage} blocks={blocks} onClose={onClose} />, host),
    );

    setDocumentComposerDraft({ text: '', mode: 'question' });
    expect(host.querySelector('[aria-label="Ask about this passage"]')).not.toBeNull();
    const textarea = type(host, 'Is this still true?');
    textarea.dispatchEvent(new FocusEvent('blur'));
    pressEnter(textarea, true);
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());

    expect(addDocumentAnnotation).toHaveBeenCalledWith(
      'question',
      'Is this still true?',
      expect.anything(),
      { askWith: expect.objectContaining({ id: 'codex' }) },
    );
    expect(saveDocumentNoteDraft).not.toHaveBeenCalled();
  });
});
