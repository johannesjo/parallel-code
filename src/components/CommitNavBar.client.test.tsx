import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommitInfo } from '../ipc/types';
import { CommitNavBar } from './CommitNavBar';

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
});

function uncommittedPill(uncommittedCount?: number | null): HTMLButtonElement | null {
  const commits: CommitInfo[] = [];
  const container = document.createElement('div');
  document.body.append(container);
  disposers.push(
    render(
      () => (
        <CommitNavBar
          commits={commits}
          selectedCommitHash={null}
          onNavigate={() => {}}
          uncommittedCount={uncommittedCount}
        />
      ),
      container,
    ),
  );
  return container.querySelector('button[title^="Uncommitted"]');
}

describe('CommitNavBar uncommitted count', () => {
  it('shows how many files have uncommitted changes', () => {
    const pill = uncommittedPill(4);
    expect(pill?.textContent).toBe('U4');
    expect(pill?.title).toBe('Uncommitted changes only (4 files)');
  });

  it('shows zero so a fully committed task is recognisable', () => {
    const pill = uncommittedPill(0);
    expect(pill?.textContent).toBe('U0');
    expect(pill?.title).toBe('Uncommitted changes only (0 files)');
  });

  it('shows a plain pill when the count is unknown', () => {
    expect(uncommittedPill(null)?.textContent).toBe('U');
    expect(uncommittedPill()?.textContent).toBe('U');
  });
});
