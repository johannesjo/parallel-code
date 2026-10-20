import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import type { AgentDef } from '../ipc/types';
import { AnnotationBubble } from './AnnotationBubble';
import type { DocumentAnnotation } from './types';

const { askFollowUpQuestion, askDocumentAnnotation, updateDocumentAnnotationText } = vi.hoisted(
  () => ({
    askFollowUpQuestion: vi.fn(async () => ({ id: 'q-2' })),
    askDocumentAnnotation: vi.fn(async () => {}),
    updateDocumentAnnotationText: vi.fn(async () => true),
  }),
);

vi.mock('./store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store')>()),
  askFollowUpQuestion,
  askDocumentAnnotation,
  updateDocumentAnnotationText,
}));

const disposers: Array<() => void> = [];

const agentDef = (id: string, name: string): AgentDef => ({
  id,
  name,
  command: id,
  args: [],
  resume_args: [],
  skip_permissions_args: [],
  description: '',
});

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  setStore({ availableAgents: [] });
  vi.clearAllMocks();
});

function question(extra: Partial<DocumentAnnotation> = {}): DocumentAnnotation {
  return {
    id: 'q-1',
    kind: 'question',
    text: 'Why is this here?',
    anchor: {
      path: 'notes.md',
      baseSha: null,
      startLine: 1,
      endLine: 2,
      quote: 'The passage',
      prefix: '',
      suffix: '',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    resolved: false,
    ...extra,
  };
}

const answered = () =>
  question({
    answerStatus: 'answered',
    answer: {
      text: 'It anchors the section.',
      agentId: 'codex',
      agentName: 'Codex',
      answeredAt: '2026-01-01T00:01:00.000Z',
    },
  });

function mount(annotation: DocumentAnnotation): HTMLElement {
  setStore({
    availableAgents: [agentDef('claude-code', 'Claude Code'), agentDef('codex', 'Codex')],
  });
  const host = document.createElement('div');
  document.body.append(host);
  disposers.push(
    render(() => <AnnotationBubble annotation={annotation} onMakeTask={() => {}} />, host),
  );
  return host;
}

function button(host: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) ?? null
  );
}

describe('AnnotationBubble follow-ups', () => {
  it('offers a follow-up to the agent that answered instead of asking again', async () => {
    const host = mount(answered());
    expect(button(host, 'Ask again · Codex')).toBeNull();
    expect(button(host, 'Ask again · Claude Code')).toBeNull();

    button(host, 'Ask follow-up')?.click();

    const box = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Follow-up question"]',
    );
    if (!box) throw new Error('No follow-up box');
    box.value = 'Could it move up?';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await vi.waitFor(() =>
      expect(askFollowUpQuestion).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'q-1' }),
        'Could it move up?',
        expect.objectContaining({ id: 'codex' }),
      ),
    );
    await vi.waitFor(() =>
      expect(host.querySelector('textarea[aria-label="Follow-up question"]')).toBeNull(),
    );
  });

  it('keeps Ask again for a question whose answer failed', () => {
    const host = mount(question({ answerStatus: 'failed', answerError: 'Timed out' }));
    expect(button(host, 'Ask follow-up')).toBeNull();
    expect(host.textContent).toContain('Timed out');
    button(host, 'Ask · Codex')?.click();
    expect(askDocumentAnnotation).toHaveBeenCalledWith(
      'q-1',
      expect.objectContaining({ id: 'codex' }),
    );
  });

  it('marks a follow-up as continuing an earlier question', () => {
    const host = mount(question({ id: 'q-2', followUpOf: 'q-1' }));
    expect(host.querySelector('.docws-bubble-meta')?.textContent).toContain('follow-up');
  });
});

describe('AnnotationBubble comments', () => {
  it('rewrites from a plain comment, which offers no Ask agent: asking is its own action', () => {
    const onMakeTask = vi.fn();
    setStore({ availableAgents: [agentDef('codex', 'Codex')] });
    const host = document.createElement('div');
    document.body.append(host);
    const note = question({ kind: 'note' });
    disposers.push(
      render(() => <AnnotationBubble annotation={note} onMakeTask={onMakeTask} />, host),
    );

    expect(host.querySelector('button[aria-label="Ask agent"]')).toBeNull();
    host.querySelector<HTMLButtonElement>('button[aria-label="Rewrite from this"]')?.click();

    expect(askDocumentAnnotation).not.toHaveBeenCalled();
    expect(onMakeTask).toHaveBeenCalledWith(note);
    expect(host.textContent).not.toContain('Waiting for');
  });

  it('marks an unanswered question with a muted wait line, and a question needs no Ask agent', () => {
    const host = mount(question({ answerStatus: 'pending' }));

    expect(host.textContent).toContain('Waiting for');
    expect(host.querySelector('button[aria-label="Ask agent"]')).toBeNull();
  });
});

it('keeps an edited note after a failed save and supports multiline text', async () => {
  const host = mount(question({ kind: 'note', text: 'Original note' }));
  host.querySelector<HTMLButtonElement>('button[aria-label="Edit comment"]')?.click();
  const box = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit comment"]');
  if (!box) throw new Error('No note editor');
  box.value = 'First thought.\nSecond thought.';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  box.dispatchEvent(new FocusEvent('blur'));
  expect(updateDocumentAnnotationText).not.toHaveBeenCalled();
  updateDocumentAnnotationText.mockResolvedValueOnce(false);
  button(host, 'Save comment')?.click();
  await vi.waitFor(() => expect(updateDocumentAnnotationText).toHaveBeenCalledOnce());
  expect(box.value).toBe('First thought.\nSecond thought.');
  expect(host.contains(box)).toBe(true);
  await vi.waitFor(() => expect(button(host, 'Save comment')?.disabled).toBe(false));
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  await vi.waitFor(() => expect(host.querySelector('textarea')).toBeNull());
  expect(updateDocumentAnnotationText).toHaveBeenLastCalledWith(
    'q-1',
    'First thought.\nSecond thought.',
  );
});
