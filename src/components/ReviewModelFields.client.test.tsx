import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { ReviewModelFields } from './ReviewModelFields';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
});

describe('ReviewModelFields', () => {
  it('names the reasoning level the review runs at when none is chosen', () => {
    dispose = render(
      () => <ReviewModelFields value={{ provider: 'claude' }} onChange={() => {}} />,
      document.body,
    );
    const select = document.querySelector<HTMLSelectElement>('[aria-label="Reasoning level"]');
    expect(select?.value).toBe('medium');
    expect([...(select?.options ?? [])].map((option) => option.value)).not.toContain('');
  });
});
