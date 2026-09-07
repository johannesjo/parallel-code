import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { AnnotationMarker } from './AnnotationMarker';
import type { DocumentAnnotation, DocumentAnnotationKind } from './types';

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
});

function annotation(id: string, text: string, kind: DocumentAnnotationKind): DocumentAnnotation {
  return {
    id,
    kind,
    text,
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
  };
}

function mount(annotations: DocumentAnnotation[]): HTMLDivElement {
  const host = document.createElement('div');
  document.body.append(host);
  disposers.push(
    render(() => <AnnotationMarker annotations={annotations} onMakeTask={() => {}} />, host),
  );
  return host;
}

describe('AnnotationMarker', () => {
  it('names the notes and questions it holds', () => {
    const host = mount([
      annotation('a', 'A thought', 'note'),
      annotation('b', 'A doubt', 'question'),
    ]);

    const button = host.querySelector<HTMLButtonElement>('.docws-marker-btn');

    expect(button?.getAttribute('aria-label')).toBe('1 note and 1 question on this passage');
    expect(button?.textContent).toContain('2');
  });

  it('spins while a question waits on its agent', () => {
    const host = mount([
      { ...annotation('b', 'A doubt', 'question'), answerStatus: 'pending' as const },
    ]);

    expect(host.querySelector('.docws-marker-btn .inline-spinner')).not.toBeNull();
    expect(host.querySelector('.docws-marker-btn svg')).toBeNull();
    expect(host.querySelector('.docws-marker-btn')?.getAttribute('aria-label')).toBe(
      '1 question on this passage, waiting for an answer',
    );
  });

  it('goes back to the glyph once the answer is in, and never spins for a note', () => {
    const answered = mount([
      { ...annotation('b', 'A doubt', 'question'), answerStatus: 'answered' as const },
    ]);
    const note = mount([annotation('a', 'A thought', 'note')]);

    for (const host of [answered, note]) {
      expect(host.querySelector('.inline-spinner')).toBeNull();
      expect(host.querySelector('.docws-marker-btn svg')).not.toBeNull();
    }
  });

  it('keeps the notes out of the prose and in the marker instead', () => {
    const host = mount([annotation('a', 'A thought', 'note')]);

    expect(host.querySelector('.docws-marker-pop')?.textContent).toContain('A thought');
    // Nothing but the marker: the block itself is left as it was written.
    expect(host.firstElementChild?.className).toContain('docws-marker');
  });

  it('shortens the time in the popover but keeps the exact stamp reachable', () => {
    const host = mount([annotation('a', 'A thought', 'note')]);
    const time = host.querySelector<HTMLElement>('.docws-marker-pop .docws-bubble-time');
    const exact = new Date('2026-01-01T00:00:00.000Z').toLocaleString();

    // The head shares its row with three buttons, so the stamp travels in the
    // title and the machine-readable value in the attribute, leaving only the
    // short form to take space.
    expect(time?.tagName).toBe('TIME');
    expect(time?.getAttribute('datetime')).toBe('2026-01-01T00:00:00.000Z');
    expect(time?.title).toBe(exact);
    expect(time?.textContent).toMatch(/\d/);
    expect(time?.textContent?.length ?? 0).toBeLessThan(exact.length);
  });

  it('pins the notes open on a click and lets Escape close them again', () => {
    const host = mount([annotation('a', 'A thought', 'note')]);
    const marker = host.querySelector<HTMLElement>('.docws-marker');
    const button = host.querySelector<HTMLButtonElement>('.docws-marker-btn');

    button?.click();
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expect(marker?.className).toContain('is-pinned');

    marker?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect(marker?.className).not.toContain('is-pinned');
  });
});
