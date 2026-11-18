import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handoff = vi.hoisted(() => ({
  blocker: vi.fn<(taskId: string) => string | null>(),
  implement: vi.fn<(taskId: string) => Promise<string | null>>(),
  planningSession: vi.fn<(taskId: string) => string | undefined>(),
  goBack: vi.fn<(taskId: string) => void>(),
  confirm: vi.fn<() => Promise<boolean>>(),
  notify: vi.fn(),
}));

vi.mock('../store/plan-handoff', () => ({
  taskPlanHandoffBlocker: handoff.blocker,
  implementPlanInFreshSession: handoff.implement,
  planningSessionToReturnTo: handoff.planningSession,
  returnToPlanningSession: handoff.goBack,
}));
vi.mock('../lib/dialog', () => ({ confirm: handoff.confirm }));
vi.mock('../store/notification', () => ({
  NOTIFICATION_ERROR_MS: 10_000,
  showNotification: handoff.notify,
}));

const { PlanHandoffActions } = await import('./PlanHandoffActions');

let dispose: (() => void) | undefined;

function renderActions(onHandedOff = vi.fn()) {
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <PlanHandoffActions taskId="t1" onHandedOff={onHandedOff} />, host);
  return onHandedOff;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const implementButton = () =>
  document.querySelector<HTMLButtonElement>('.plan-implement-fresh-btn');
const backButton = () => document.querySelector<HTMLButtonElement>('.plan-back-to-planning-btn');

beforeEach(() => {
  handoff.blocker.mockReturnValue(null);
  handoff.implement.mockResolvedValue(null);
  handoff.planningSession.mockReturnValue(undefined);
  handoff.confirm.mockResolvedValue(true);
});

afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('PlanHandoffActions', () => {
  it('hands the plan over and closes the viewer', async () => {
    const onHandedOff = renderActions();
    implementButton()?.click();
    await flush();
    expect(handoff.implement).toHaveBeenCalledWith('t1');
    expect(onHandedOff).toHaveBeenCalledOnce();
  });

  it('explains why the handoff is unavailable', () => {
    handoff.blocker.mockReturnValue('Send or clear the text in the prompt box first.');
    renderActions();
    expect(implementButton()?.disabled).toBe(true);
    expect(implementButton()?.title).toBe('Send or clear the text in the prompt box first.');
  });

  it('keeps the viewer open and says why when the handoff is refused', async () => {
    handoff.implement.mockResolvedValue('The agent changed. Try again.');
    const onHandedOff = renderActions();
    implementButton()?.click();
    await flush();
    expect(handoff.notify).toHaveBeenCalledWith('The agent changed. Try again.', {
      durationMs: 10_000,
    });
    expect(onHandedOff).not.toHaveBeenCalled();
  });

  it('offers the planning session only when there is one to go back to', () => {
    renderActions();
    expect(backButton()).toBeNull();
  });

  it('goes back to the planning session after confirmation', async () => {
    handoff.planningSession.mockReturnValue('s1');
    renderActions();
    backButton()?.click();
    await flush();
    expect(handoff.goBack).toHaveBeenCalledWith('t1');
  });

  it('stays in the current session when the user cancels', async () => {
    handoff.planningSession.mockReturnValue('s1');
    handoff.confirm.mockResolvedValue(false);
    renderActions();
    backButton()?.click();
    await flush();
    expect(handoff.goBack).not.toHaveBeenCalled();
  });
});
