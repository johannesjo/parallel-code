import { afterEach, describe, expect, it } from 'vitest';
import {
  getAgentActivityEvidence,
  getAgentActivitySnapshot,
  invalidateAgentActivity,
  observeAgentHook,
  onAgentActivityObservation,
  registerAgentLaunch,
  retireAgentLaunch,
} from './observations.js';
import { AGENT_HOOK_STALE_MS, type AgentHookEventPayload } from './status.js';

const agentId = 'observations-agent';
const taskId = 'observations-task';
const launchId = 'observations-launch';
const event = (update: Partial<AgentHookEventPayload>): AgentHookEventPayload => ({
  agentId,
  taskId,
  launchId,
  state: 'working',
  event: 'UserPromptSubmit',
  at: 100,
  ...update,
});

afterEach(() => {
  const current = getAgentActivitySnapshot().observations.find((item) => item.agentId === agentId);
  if (current) retireAgentLaunch(agentId, current.launchId);
});

describe('live agent activity observations', () => {
  it('starts unknown and rejects missing, stale, and wrong-task identities', () => {
    registerAgentLaunch(agentId, taskId, launchId);
    expect(getAgentActivityEvidence(agentId)).toEqual({
      agentId,
      launchId,
      source: 'process',
      activity: 'unknown',
      event: 'ProcessStarted',
      freshness: 'unknown',
    });
    expect(observeAgentHook(event({ launchId: undefined }))).toBeUndefined();
    expect(observeAgentHook(event({ launchId: 'old' }))).toBeUndefined();
    expect(observeAgentHook(event({ taskId: 'other' }))).toBeUndefined();
    expect(getAgentActivityEvidence(agentId)?.source).toBe('process');
  });

  it('preserves matching-tool waits and their onset across unrelated results', () => {
    registerAgentLaunch(agentId, taskId, launchId);
    observeAgentHook(
      event({
        state: 'waiting',
        event: 'PermissionRequest',
        toolUseId: 'a',
        prompt: 'permission',
        detail: 'npm test',
      }),
    );
    const before = getAgentActivitySnapshot();
    expect(
      observeAgentHook(event({ event: 'PostToolUse', toolUseId: 'b', at: 200 })),
    ).toBeUndefined();
    expect(getAgentActivitySnapshot()).toEqual(before);
    observeAgentHook(event({ state: 'waiting', event: 'Notification', at: 300 }));
    expect(
      getAgentActivitySnapshot().observations.find((item) => item.agentId === agentId),
    ).toMatchObject({ state: 'waiting', toolUseId: 'a', since: 100, at: 300 });
    observeAgentHook(event({ event: 'PostToolUse', toolUseId: 'a', at: 400 }));
    expect(getAgentActivityEvidence(agentId, 400)).toMatchObject({
      activity: 'working',
      since: 400,
      observedAt: 400,
    });
  });

  it('distinguishes readiness from turn completion and retains failure context', () => {
    registerAgentLaunch(agentId, taskId, launchId);
    observeAgentHook(event({ state: 'done', event: 'SessionStart', at: 1 }));
    expect(getAgentActivityEvidence(agentId, 2)).toMatchObject({ activity: 'ready', since: 1 });
    observeAgentHook(
      event({ state: 'done', event: 'StopFailure', detail: 'Provider unavailable', at: 100 }),
    );
    expect(getAgentActivityEvidence(agentId, 100 + AGENT_HOOK_STALE_MS)).toMatchObject({
      activity: 'turn_finished',
      since: 100,
      detail: 'Provider unavailable',
      freshness: 'current',
    });
    // The idle reminder says nothing new about a failed turn.
    expect(
      observeAgentHook(event({ state: 'done', event: 'Notification', at: 200 })),
    ).toBeUndefined();
    expect(getAgentActivityEvidence(agentId, 201)).toMatchObject({
      activity: 'turn_finished',
      event: 'StopFailure',
      since: 100,
      detail: 'Provider unavailable',
    });
  });

  it('turns a finished turn into readiness on the idle reminder', () => {
    registerAgentLaunch(agentId, taskId, launchId);
    observeAgentHook(event({ state: 'done', event: 'Stop', at: 100 }));
    observeAgentHook(event({ state: 'done', event: 'Notification', at: 200 }));
    expect(getAgentActivityEvidence(agentId, 201)).toMatchObject({ activity: 'ready', since: 200 });
  });

  it('keeps an unanswered wait current however long it lasts', () => {
    registerAgentLaunch(agentId, taskId, launchId);
    observeAgentHook(event({ state: 'waiting', event: 'PermissionRequest', prompt: 'permission' }));
    expect(getAgentActivityEvidence(agentId, 100 + AGENT_HOOK_STALE_MS)).toMatchObject({
      activity: 'waiting',
      freshness: 'current',
    });
  });

  it('expires ongoing evidence without mutating the snapshot and invalidates finished facts', () => {
    registerAgentLaunch(agentId, taskId, launchId);
    observeAgentHook(event({}));
    const before = getAgentActivitySnapshot();
    expect(getAgentActivityEvidence(agentId, 100 + AGENT_HOOK_STALE_MS)?.freshness).toBe('stale');
    expect(getAgentActivitySnapshot()).toEqual(before);
    observeAgentHook(event({ state: 'done', event: 'Stop' }));
    invalidateAgentActivity(agentId, 'wrong-launch');
    expect(getAgentActivityEvidence(agentId)?.activity).toBe('turn_finished');
    invalidateAgentActivity(agentId, launchId);
    expect(getAgentActivityEvidence(agentId)).toMatchObject({
      source: 'process',
      activity: 'unknown',
      event: 'PromptSubmitted',
      freshness: 'unknown',
    });
    expect(getAgentActivityEvidence(agentId)?.observedAt).toBeUndefined();
  });

  it('orders lifecycle events and guards old retirement against a replacement', () => {
    const observations: { sequence: number; kind: string }[] = [];
    const off = onAgentActivityObservation((observation) => observations.push(observation));
    try {
      registerAgentLaunch(agentId, taskId, launchId);
      observeAgentHook(event({}));
      registerAgentLaunch(agentId, taskId, 'replacement');
      retireAgentLaunch(agentId, launchId);
      expect(getAgentActivityEvidence(agentId)?.launchId).toBe('replacement');
      expect(observeAgentHook(event({ state: 'done', event: 'Stop' }))).toBeUndefined();
      retireAgentLaunch(agentId, 'replacement');
      expect(getAgentActivityEvidence(agentId)).toBeUndefined();
      expect(getAgentActivitySnapshot().observations.some((item) => item.agentId === agentId)).toBe(
        false,
      );
      expect(observations.map((item) => item.kind)).toEqual([
        'launch',
        'hook',
        'launch',
        'retired',
      ]);
      expect(
        observations.every(
          (item, index) => index === 0 || item.sequence > observations[index - 1].sequence,
        ),
      ).toBe(true);
    } finally {
      off();
    }
  });

  it('returns copies so snapshot callers cannot rewrite the cache', () => {
    registerAgentLaunch(agentId, taskId, launchId);
    const snapshot = getAgentActivitySnapshot();
    const current = snapshot.observations.find((item) => item.agentId === agentId);
    if (!current) throw new Error('Missing test launch');
    current.launchId = 'forged';
    snapshot.observations.length = 0;
    expect(getAgentActivityEvidence(agentId)?.launchId).toBe(launchId);
  });
});
