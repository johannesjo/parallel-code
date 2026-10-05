// Pushes the desktop's per-task attention state (working, needs input, ready,
// error, …) to the main process so the mobile overview can show a richer
// status, prioritizing unanswered questions. The renderer owns this
// computation because it depends on reactive terminal/git/steps state; main
// simply caches the latest snapshot and re-broadcasts it to connected phones.
//
// See electron/ipc/register.ts (Remote_UpdateTaskStatus handler) for the
// main-side cache, and electron/remote/server.ts buildAgentList for how the
// cached attention is attached to each RemoteAgent.

import { createEffect, createRoot, onCleanup, untrack } from 'solid-js';
import { store } from './store';
import {
  getTaskAttentionState,
  getTaskOpenQuestion,
  getAgentOutputTail,
  stripAnsi,
} from './taskStatus';
import { taskUsesAgentChat } from './agent-chat';
import { fireAndForget } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import type { RemoteAttentionState, RemoteAgent } from '../../electron/remote/protocol';
import type { AgentChatState } from '../../electron/shared/agent-chat-types';

/** Pick recent content rather than terminal UI chrome for the phone's task cards. */
export function remoteOutputPreview(rawTail: string): string {
  // Preserve row boundaries before stripping cursor movement. DEC line-drawing
  // characters otherwise appear as literal q's when their charset escapes vanish.
  /* eslint-disable no-control-regex */
  const text = stripAnsi(
    rawTail
      .replace(/\x1b\(0[\s\S]*?\x1b\(B/g, '\n')
      .replace(/\x1b\[(?:\d+;)?\d*[Hf]|\x1b\[\d*[ABEF]/g, '\n'),
  )
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(
      /You\s+have\s+\d+\s+usage\s+limit\s+resets?\s+available\.\s*Run\s+\/usage\s+to\s+use\s+one\./g,
      '',
    );
  /* eslint-enable no-control-regex */
  const lines = text.split(/\r\n?|\n/).map((line) => line.trim());
  const content = lines.filter(
    (line) =>
      line &&
      !/^(?:q\s*)+$/.test(line) &&
      !/^[›❯─━═│┌┐└┘├┤┬┴┼╭╮╰╯\s]+$/.test(line) &&
      !/^[│┃║]?\s*[›❯>]?\s*Ask\s+Codex\s+to\s+do\s+anything(?:…|\.{3})?\s*[│┃║]?$/i.test(line) &&
      !/^gpt-\S+[ \t]+[^\r\n]*[·•][ \t]+(?:\/|~\/)[^\r\n]*$/.test(line),
  );
  return (content.at(-1) ?? '').slice(0, 300);
}

/** The last line the agent wrote in a chat, as the phone's task card preview. */
export function remoteChatPreview(state: AgentChatState | undefined): string {
  const reply = state?.items.findLast((item) => item.kind === 'assistant' && item.text.trim());
  return (reply?.text.trim().split('\n').at(-1) ?? '').trim().slice(0, 300);
}

export function startRemoteStatusSync(): () => void {
  // Serialized snapshot of the last push, so we only send on actual change.
  let lastSerialized = '';

  // createRoot gives the effect an explicit owner whose disposer we return, so
  // the sync actually stops when the caller invokes it. Called from an async
  // onMount past the first await, the ambient owner is already gone, so relying
  // on onCleanup/owner-disposal alone would leave the effect running forever.
  return createRoot((dispose) => {
    const sync = () => {
      // Only sync while the remote (Connect Phone) server is running — otherwise
      // no phone is listening and the push is wasted. Reading `enabled` here also
      // makes the effect re-run (and resume syncing) when the server starts.
      if (!store.remoteAccess.enabled) {
        lastSerialized = '';
        return;
      }

      const statuses: Record<string, RemoteAttentionState> = {};
      const contexts: Record<
        string,
        Pick<
          RemoteAgent,
          'projectName' | 'projectColor' | 'agentName' | 'lastLine' | 'taskName' | 'collapsed'
        >
      > = {};
      for (const taskId of [...store.taskOrder, ...store.collapsedTaskOrder]) {
        // Like the desktop attention tray, surface unanswered questions even
        // when a review flag or another agent's failure masks the task status.
        statuses[taskId] = getTaskOpenQuestion(taskId)
          ? 'needs_input'
          : getTaskAttentionState(taskId);
        const task = store.tasks[taskId];
        if (!task) continue;
        const agentId =
          task.agentIds.find((id) => store.agents[id]?.status === 'running') ?? task.agentIds[0];
        const agent = store.agents[agentId];
        const project = store.projects.find((project) => project.id === task.projectId);
        contexts[taskId] = {
          taskName: task.name,
          collapsed: Boolean(task.collapsed),
          projectName: project?.name ?? '',
          projectColor: project?.color ?? '',
          agentName: agent?.def.name ?? task.savedAgentDef?.name ?? '',
          // Untracked like the terminal tail: a streaming reply changes every frame.
          lastLine: taskUsesAgentChat(task)
            ? untrack(() =>
                remoteChatPreview(
                  task.agentIds[0] ? store.agents[task.agentIds[0]]?.chatState : undefined,
                ),
              )
            : agentId
              ? remoteOutputPreview(getAgentOutputTail(agentId))
              : '',
        };
      }

      const serialized = JSON.stringify({ statuses, contexts });
      if (serialized === lastSerialized) return;
      lastSerialized = serialized;
      fireAndForget(IPC.Remote_UpdateTaskStatus, { statuses, contexts });
    };
    createEffect(sync);
    // Output tails are non-reactive; keep previews current even during a long turn.
    const timer = setInterval(sync, 2000);
    onCleanup(() => clearInterval(timer));

    return dispose;
  });
}
