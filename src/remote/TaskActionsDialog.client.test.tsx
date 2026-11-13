import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskActionsDialog } from './TaskActionsDialog';
import { closeTask, mergeTask, type ReadinessCheck } from './api';

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
      baseBranch: 'main',
      deleteBranchOnClose: undefined,
    }),
  ),
  mergeTask: vi.fn(() => Promise.resolve({ ok: true })),
  closeTask: vi.fn(() => Promise.resolve({ warnings: [] })),
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

function mount(canAct: boolean, startOnClose = false) {
  const host = document.createElement('div');
  document.body.append(host);
  const done = vi.fn();
  disposers.push(
    render(
      () => (
        <TaskActionsDialog
          taskId="task-1"
          taskName="Demo"
          canAct={canAct}
          onClose={() => {}}
          onNeedsPairing={() => {}}
          onDone={done}
          startOnClose={startOnClose}
        />
      ),
      host,
    ),
  );
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  return { host, done, button };
}

describe('TaskActionsDialog as Finish', () => {
  it('merges from one screen with the options set there, like desktop Finish', async () => {
    vi.mocked(mergeTask).mockClear();
    const { host, done, button } = mount(true);
    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Finish task');
    expect(host.querySelector('.mobile-dialog-title')?.textContent).toBe('Finish Demo');
    await vi.waitFor(() => expect(button('Merge')?.disabled).toBe(false));
    expect(host.textContent).toContain('Merge into main');
    const squash = [...host.querySelectorAll('label')].find((l) =>
      l.textContent?.includes('Squash'),
    );
    squash?.querySelector('input')?.click();
    button('Merge')?.click();
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(mergeTask).toHaveBeenCalledWith('task-1', { squash: true, cleanup: false });
  });

  it('still confirms before closing the task', async () => {
    vi.mocked(closeTask).mockClear();
    const { done, button } = mount(true);
    button('Close task…')?.click();
    expect(closeTask).not.toHaveBeenCalled();
    button('Close task')?.click();
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(closeTask).toHaveBeenCalledWith('task-1', false);
  });

  it('shows a view-only phone the checks but no actions', async () => {
    const { host, button } = mount(false);
    await vi.waitFor(() => expect(host.querySelectorAll('.mobile-readiness-row').length).toBe(3));
    expect(button('Merge')).toBeUndefined();
    expect(button('Close task…')).toBeUndefined();
    expect(host.textContent).toContain('Pair this phone to merge or close tasks.');
    expect(button('Done')).toBeDefined();
  });

  it("opens a Done card's Close on the confirmation, or on the pairing hint when view-only", () => {
    expect(mount(true, true).host.textContent).toContain('Close Demo?');
    const viewOnly = mount(false, true);
    expect(viewOnly.host.textContent).not.toContain('Close Demo?');
    expect(viewOnly.host.textContent).toContain('Pair this phone to merge or close tasks.');
  });
});
