import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskActionsDialog } from './TaskActionsDialog';
import type { ReadinessCheck } from './api';

// The dialog is driven entirely by the readiness resource; hand it a fixed
// payload so the rows below render deterministically.
vi.mock('./api', () => ({
  fetchMergeReadiness: vi.fn(() =>
    Promise.resolve({
      readiness: {
        overall: 'ready',
        checks: [
          { label: 'Working tree clean', detail: 'Nothing uncommitted.', status: 'pass' },
          { label: 'Verify passed', detail: 'All checks green.', status: 'pass' },
          { label: 'Up to date', detail: 'No conflicts with the base.', status: 'pass' },
        ] satisfies ReadinessCheck[],
      },
      canMerge: true,
      deleteBranchOnClose: undefined,
    }),
  ),
  mergeTask: vi.fn(),
  closeTask: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
});

describe('TaskActionsDialog readiness symbols', () => {
  it('gives every row of the same status its own icon node', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(
        () => (
          <TaskActionsDialog
            taskId="task-1"
            taskName="Demo"
            canAct
            onClose={() => {}}
            onNeedsPairing={() => {}}
            onDone={() => {}}
          />
        ),
        host,
      ),
    );

    // Wait for the resource to resolve and the rows to render.
    await vi.waitFor(() => {
      expect(host.querySelectorAll('.mobile-readiness-row').length).toBe(3);
    });

    // Regression: a module-level JSX element is moved between <For> rows by
    // Solid, so only the last row kept its svg. Each row now builds its own.
    const rows = Array.from(host.querySelectorAll('.mobile-readiness-row'));
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(
        row.querySelector('.mobile-readiness-symbol svg'),
        row.textContent ?? '',
      ).not.toBeNull();
    }
    expect(host.querySelectorAll('.mobile-readiness-symbol svg').length).toBe(3);
  });
});
