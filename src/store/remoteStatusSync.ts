// Pushes the desktop's per-task attention state (working, needs input, ready,
// error, …) to the main process so the mobile overview can show the same
// richer status instead of just running/exited. The renderer owns this
// computation because it depends on reactive terminal/git/steps state; main
// simply caches the latest snapshot and re-broadcasts it to connected phones.
//
// See electron/ipc/register.ts (Remote_UpdateTaskStatus handler) for the
// main-side cache, and electron/remote/server.ts buildAgentList for how the
// cached attention is attached to each RemoteAgent.

import { createEffect, onCleanup } from 'solid-js';
import { store } from './store';
import { getTaskAttentionState } from './taskStatus';
import { fireAndForget } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import type { RemoteAttentionState } from '../../electron/remote/protocol';

export function startRemoteStatusSync(): () => void {
  // Serialized snapshot of the last push, so we only send on actual change.
  let lastSerialized = '';

  createEffect(() => {
    // Only sync while the remote (Connect Phone) server is running — otherwise
    // no phone is listening and the push is wasted. Reading `enabled` here also
    // makes the effect re-run (and resume syncing) when the server starts.
    if (!store.remoteAccess.enabled) {
      lastSerialized = '';
      return;
    }

    const statuses: Record<string, RemoteAttentionState> = {};
    for (const taskId of [...store.taskOrder, ...store.collapsedTaskOrder]) {
      statuses[taskId] = getTaskAttentionState(taskId);
    }

    const serialized = JSON.stringify(statuses);
    if (serialized === lastSerialized) return;
    lastSerialized = serialized;
    fireAndForget(IPC.Remote_UpdateTaskStatus, { statuses });
  });

  const cleanup = (): void => {};
  onCleanup(cleanup);
  return cleanup;
}
