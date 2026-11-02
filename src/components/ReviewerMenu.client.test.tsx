import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewModelSettings } from '../lib/task-review';
import { ReviewerMenu } from './ReviewerMenu';

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = '';
});

function titleFor(value: ReviewModelSettings): string {
  const root = document.createElement('div');
  document.body.append(root);
  dispose = render(() => <ReviewerMenu value={value} onChange={() => {}} />, root);
  const menu = root.querySelector('[aria-label^="Reviewer model"]');
  if (!menu) throw new Error('Missing reviewer menu');
  return menu.getAttribute('title') ?? '';
}

describe('ReviewerMenu', () => {
  it('names the level a Claude review runs at when none is picked', () => {
    // Switching back to Claude in the menu drops the level; the review still runs at high.
    expect(titleFor({ provider: 'claude', model: 'opus' })).toBe('Reviewer: opus · High');
  });

  it('names a level the user picked', () => {
    expect(titleFor({ provider: 'claude', model: 'opus', effort: 'low' })).toBe(
      'Reviewer: opus · Low',
    );
  });
});
