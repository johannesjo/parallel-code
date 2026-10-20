import { produce } from 'solid-js/store';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { sessionAgentForCommand, type SessionRecord } from '../../electron/shared/session-record';
import { canResumeSessionId } from '../../electron/shared/session-resume';
import { store, setStore } from './core';
import { restartAgent } from './agents';
import { forgetAgentPrompts } from '../lib/prompt-history';
import { saveState } from './persistence';
import { warn as logWarn, errMessage } from '../lib/log';

/**
 * Sessions a pane could resume: those this CLI can actually reattach to,
 * newest first.
 *
 * Filtered by agent because a Claude session id means nothing to Codex — the
 * launch would fail rather than fall back. Fetched on demand rather than
 * polled: the transcript scan touches the filesystem, and nothing needs this
 * list until someone opens the picker.
 */
export async function listResumableSessions(
  taskId: string,
  command: string,
): Promise<SessionRecord[]> {
  const task = store.tasks[taskId];
  if (!task || !canResumeSessionId(command)) return [];
  const agent = sessionAgentForCommand(command);
  if (!agent) return [];
  try {
    const sessions = await invoke<SessionRecord[]>(IPC.ListSessions, { cwd: task.worktreePath });
    return sessions.filter((session) => session.agent === agent);
  } catch (err) {
    logWarn('sessions', 'failed to list sessions', { taskId, error: errMessage(err) });
    return [];
  }
}

/**
 * Point a pane at a specific session and relaunch it there.
 *
 * The id is stored before the restart so the relaunch reads it, and the
 * restart passes `useResumeArgs` so `assignFreshSessionId` leaves it alone
 * instead of minting a replacement.
 */
export function resumeAgentSession(taskId: string, agentId: string, sessionId: string): void {
  if (!store.tasks[taskId]) return;
  setStore(
    produce((s) => {
      const task = s.tasks[taskId];
      if (!task) return;
      task.agentSessionIds ??= {};
      // Another conversation's prompts would read as this one's.
      if (task.agentSessionIds[agentId] !== sessionId) forgetAgentPrompts(task, agentId);
      task.agentSessionIds[agentId] = sessionId;
      // An explicit picker choice replaces an earlier chat-to-terminal handoff.
      if (task.agentIds[0] === agentId) task.codexChatHandoff = undefined;
    }),
  );
  restartAgent(agentId, true);
  void saveState();
}
