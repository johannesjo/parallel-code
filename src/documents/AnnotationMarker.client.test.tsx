import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnnotationMarker } from './AnnotationMarker';
import type { DocumentAnnotation, DocumentAnnotationKind } from './types';
import { dismissPinnedBubbles } from './workspace-ui';

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

  it('keeps the notes out of the prose, floating over the window', () => {
    const host = mount([annotation('a', 'A thought', 'note')]);

    const pop = document.querySelector<HTMLElement>('.docws-marker-pop');
    expect(pop?.textContent).toContain('A thought');
    // Nothing but the symbol in the block: the popover cannot be clipped by a
    // page element or covered by the composer, so it is not inside either.
    expect(host.firstElementChild?.className).toContain('docws-marker');
    expect(host.contains(pop)).toBe(false);
    expect(document.body.contains(pop)).toBe(true);
  });

  it('opens on hover and holds while the pointer crosses onto the popover', async () => {
    const host = mount([annotation('a', 'A thought', 'note')]);
    const marker = host.querySelector<HTMLElement>('.docws-marker');
    const pop = document.querySelector<HTMLElement>('.docws-marker-pop');
    expect(pop?.classList.contains('is-open')).toBe(false);

    marker?.dispatchEvent(new MouseEvent('mouseenter'));
    expect(pop?.classList.contains('is-open')).toBe(true);
    expect(pop?.style.top).toMatch(/px$/);

    marker?.dispatchEvent(new MouseEvent('mouseleave'));
    pop?.dispatchEvent(new MouseEvent('mouseenter'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(pop?.classList.contains('is-open')).toBe(true);

    pop?.dispatchEvent(new MouseEvent('mouseleave'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(pop?.classList.contains('is-open')).toBe(false);
  });

  it('shortens the time in the popover but keeps the exact stamp reachable', () => {
    mount([annotation('a', 'A thought', 'note')]);
    const time = document.querySelector<HTMLElement>('.docws-marker-pop .docws-bubble-time');
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

  it('lets go of its click-outside listener when unpinned and when unmounted', () => {
    const added = vi.spyOn(document, 'addEventListener');
    const removed = vi.spyOn(document, 'removeEventListener');
    const host = mount([annotation('a', 'A thought', 'note')]);
    const button = host.querySelector<HTMLButtonElement>('.docws-marker-btn');
    const mousedowns = (spy: typeof added) =>
      spy.mock.calls.filter(([type]) => type === 'mousedown').length;

    button?.click();
    button?.click();
    button?.click();
    expect(mousedowns(added)).toBe(2);
    expect(mousedowns(removed)).toBe(1);

    disposers.pop()?.();

    expect(mousedowns(removed)).toBe(2);
    added.mockRestore();
    removed.mockRestore();
  });

  it('pins the notes open on a click and lets Escape close them again', () => {
    const host = mount([annotation('a', 'A thought', 'note')]);
    const marker = host.querySelector<HTMLElement>('.docws-marker');
    const button = host.querySelector<HTMLButtonElement>('.docws-marker-btn');

    button?.click();
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expect(marker?.className).toContain('is-pinned');
    expect(document.querySelector('.docws-marker-pop')?.classList.contains('is-open')).toBe(true);

    marker?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect(marker?.className).not.toContain('is-pinned');
    expect(document.querySelector('.docws-marker-pop')?.classList.contains('is-open')).toBe(false);
  });

  it('takes Escape from inside the popover for itself and hands the focus back', () => {
    const host = mount([annotation('a', 'A thought', 'note')]);
    const button = host.querySelector<HTMLButtonElement>('.docws-marker-btn');
    const pop = document.querySelector<HTMLElement>('.docws-marker-pop');
    const resolve = pop?.querySelector<HTMLButtonElement>('button');
    const escaped = vi.fn();
    window.addEventListener('keydown', escaped);

    button?.click();
    resolve?.focus();
    resolve?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    // The window's shortcuts would read the same key as "close the workspace".
    expect(escaped).not.toHaveBeenCalled();
    expect(pop?.classList.contains('is-open')).toBe(false);
    expect(document.activeElement).toBe(button);
    window.removeEventListener('keydown', escaped);
  });

  it('closes a bubble that focus alone holds open, and stays closed on the symbol', () => {
    const host = mount([annotation('a', 'A thought', 'note')]);
    const marker = host.querySelector<HTMLElement>('.docws-marker');
    const button = host.querySelector<HTMLButtonElement>('.docws-marker-btn');
    const pop = document.querySelector<HTMLElement>('.docws-marker-pop');

    button?.focus();
    expect(pop?.classList.contains('is-open')).toBe(true);

    marker?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(pop?.classList.contains('is-open')).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  it('lets the workspace dismiss a pinned bubble from wherever the focus is', () => {
    const host = mount([annotation('a', 'A thought', 'note')]);
    const button = host.querySelector<HTMLButtonElement>('.docws-marker-btn');
    const pop = document.querySelector<HTMLElement>('.docws-marker-pop');

    expect(dismissPinnedBubbles()).toBe(false);
    button?.click();
    expect(pop?.classList.contains('is-open')).toBe(true);

    expect(dismissPinnedBubbles()).toBe(true);
    expect(pop?.classList.contains('is-open')).toBe(false);
    expect(dismissPinnedBubbles()).toBe(false);
  });
});
