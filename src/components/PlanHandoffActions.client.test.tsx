import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handoff = vi.hoisted(() => ({
  blocker: vi.fn<(taskId: string) => string | null>(),
  implement: vi.fn<(taskId: string) => Promise<string | null>>(),
  planningSession: vi.fn<(taskId: string) => string | undefined>(),
  goBack: vi.fn<(taskId: string) => string | null>(),
  backBlocker: vi.fn<(taskId: string) => string | null>(),
  confirm: vi.fn<() => Promise<boolean>>(),
  notify: vi.fn(),
}));

vi.mock('../store/plan-handoff', () => ({
  taskPlanHandoffBlocker: handoff.blocker,
  implementPlanInFreshSession: handoff.implement,
  planningSessionToReturnTo: handoff.planningSession,
  returnToPlanningSession: handoff.goBack,
  returnToPlanningBlocker: handoff.backBlocker,
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
  handoff.goBack.mockReturnValue(null);
  handoff.backBlocker.mockReturnValue(null);
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

  // The viewer closes on handoff, so the way back is offered where the user looks.
  it('offers going back from the handoff notice, without asking again', async () => {
    renderActions();
    implementButton()?.click();
    await flush();
    expect(handoff.notify).toHaveBeenCalledWith('Plan sent to a fresh session.', {
      durationMs: 10_000,
      action: expect.objectContaining({ label: 'Back to planning' }),
    });
    const [, opts] = handoff.notify.mock.calls[0] as [string, { action: { run: () => void } }];
    opts.action.run();
    expect(handoff.goBack).toHaveBeenCalledWith('t1');
    expect(handoff.confirm).not.toHaveBeenCalled();
  });

  it('says why when going back from the handoff notice is refused', async () => {
    handoff.goBack.mockReturnValue('Send or clear the text typed into the agent first.');
    renderActions();
    implementButton()?.click();
    await flush();
    const [, opts] = handoff.notify.mock.calls[0] as [string, { action: { run: () => void } }];
    opts.action.run();
    expect(handoff.notify).toHaveBeenLastCalledWith(
      'Send or clear the text typed into the agent first.',
      { durationMs: 10_000 },
    );
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
    // Only the refusal, no success notice: a refused handoff has nothing to go back from.
    expect(handoff.notify).toHaveBeenCalledOnce();
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

  it('explains why going back is unavailable', () => {
    handoff.planningSession.mockReturnValue('s1');
    handoff.backBlocker.mockReturnValue('Send or clear the text typed into the agent first.');
    renderActions();
    expect(backButton()?.disabled).toBe(true);
    expect(backButton()?.title).toBe('Send or clear the text typed into the agent first.');
  });

  // The user can type into the agent while the confirmation is open.
  it('keeps the viewer open and says why when going back is refused', async () => {
    handoff.planningSession.mockReturnValue('s1');
    handoff.goBack.mockReturnValue('Send or clear the text typed into the agent first.');
    const onHandedOff = renderActions();
    backButton()?.click();
    await flush();
    expect(handoff.notify).toHaveBeenCalledWith(
      'Send or clear the text typed into the agent first.',
      { durationMs: 10_000 },
    );
    expect(onHandedOff).not.toHaveBeenCalled();
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
