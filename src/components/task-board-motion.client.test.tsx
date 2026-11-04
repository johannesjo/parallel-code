import { For, createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCardMotion } from './task-board-motion';

vi.mock('../lib/reducedMotion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/reducedMotion')>()),
  prefersMotion: () => true,
}));

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('useCardMotion', () => {
  it('fades ideas in when added and leaves a fading ghost when removed', () => {
    const animate = vi.fn(() => ({ cancel() {}, finished: new Promise<void>(() => {}) }));
    Object.defineProperty(HTMLElement.prototype, 'animate', { value: animate, configurable: true });
    const [ideas, setIdeas] = createSignal(['a']);
    const host = document.createElement('div');
    document.body.append(host);
    dispose = render(() => {
      let root: HTMLDivElement | undefined;
      useCardMotion(() => root, ideas);
      return (
        <div ref={root}>
          <For each={ideas()}>{(id) => <li data-board-idea={id}>{id}</li>}</For>
        </div>
      );
    }, host);

    setIdeas(['b', 'a']);
    const added = host.querySelector('[data-board-idea="b"]');
    expect(animate.mock.contexts).toContain(added);

    setIdeas(['a']);
    const ghost = [...host.querySelectorAll('li')].find((li) => li.textContent === 'b');
    expect(ghost?.getAttribute('aria-hidden')).toBe('true');
    expect(ghost?.hasAttribute('data-board-idea')).toBe(false);
    expect(animate.mock.contexts).toContain(ghost);
  });
});
