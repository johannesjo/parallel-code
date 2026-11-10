// wait_for_idle: holding a caller until a child's agent is back at its prompt.

import type { CoordinatorInternals } from './internals.js';
import { clampWaitTimeoutMs, DEFAULT_WAIT_TIMEOUT_MS } from './signal-waits.js';

export function waitForIdle(
  c: CoordinatorInternals,
  taskId: string,
  timeoutMs?: number,
): Promise<{ reason: 'idle' | 'human_control' | 'exited' | 'removed' }> {
  return waitForIdleInternal(c, taskId, clampWaitTimeoutMs(timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS));
}

function waitForIdleInternal(
  c: CoordinatorInternals,
  taskId: string,
  timeoutMs: number,
): Promise<{ reason: 'idle' | 'human_control' | 'exited' | 'removed' }> {
  const task = c.tasks.get(taskId);
  if (!task) return Promise.reject(new Error(`Task not found: ${taskId}`));
  if (c.controlMap.get(taskId) === 'human') {
    if (task.initialPrompt || c.prompts.hasQueuedWork(task)) {
      return waitForIdleResolver(c, taskId, timeoutMs);
    }
    return Promise.resolve({ reason: 'human_control' }); // resolve immediately — caller gets control-change event instead
  }
  if (task.status === 'exited') return Promise.resolve({ reason: 'exited' });
  // An errored task never reaches idle; 'exited' is the closest terminal reason.
  if (task.status === 'error') return Promise.resolve({ reason: 'exited' });
  // Idle only counts once the assignment was delivered and nothing is queued;
  // otherwise the ❯ seen so far is the startup prompt, not finished work.
  if (task.status === 'idle' && !c.prompts.hasUndeliveredPrompt(task)) {
    return Promise.resolve({ reason: 'idle' });
  }

  return waitForIdleResolver(c, taskId, timeoutMs);
}

function waitForIdleResolver(
  c: CoordinatorInternals,
  taskId: string,
  timeoutMs: number,
): Promise<{ reason: 'idle' | 'human_control' | 'exited' | 'removed' }> {
  return new Promise((resolve, reject) => {
    const timerRef = { value: undefined as ReturnType<typeof setTimeout> | undefined };

    const wrappedResolve = (result: {
      reason: 'idle' | 'human_control' | 'exited' | 'removed';
    }) => {
      if (timerRef.value !== undefined) clearTimeout(timerRef.value);
      resolve(result);
    };

    timerRef.value = setTimeout(() => {
      const resolvers = c.idleResolvers.get(taskId);
      if (resolvers) {
        const idx = resolvers.indexOf(wrappedResolve);
        if (idx >= 0) resolvers.splice(idx, 1);
      }
      reject(new Error(`Timed out waiting for task ${taskId} to become idle`));
    }, timeoutMs);

    let resolvers = c.idleResolvers.get(taskId);
    if (!resolvers) {
      resolvers = [];
      c.idleResolvers.set(taskId, resolvers);
    }
    resolvers.push(wrappedResolve);
  });
}
