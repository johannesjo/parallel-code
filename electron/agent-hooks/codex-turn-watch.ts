import { getAgentPromptReadiness } from '../shared/prompt-detect.js';
import type { AgentHookEventPayload } from './status.js';

const CHECK_MS = 2_000;

export interface CodexTurnWatch {
  /** Takes every Codex status event, in the order it arrived. */
  note: (event: AgentHookEventPayload) => void;
  stop: () => void;
}

interface CodexTurnWatchOptions {
  /** The rendered screen of the launch an event came from, or null once it is gone. */
  screenText: (event: AgentHookEventPayload) => string | null;
  onFailed: (event: AgentHookEventPayload) => void;
  checkMs?: number;
  now?: () => number;
}

/**
 * Codex runs no hook when a turn fails (a model error, a usage limit), so its
 * last word would be "working" for good. A running turn keeps a "Working" row
 * above the input box, with or without animations; the empty input box without
 * that row, seen on two checks in a row, means the turn ended unreported.
 */
export function createCodexTurnWatch(options: CodexTurnWatchOptions): CodexTurnWatch {
  const timers = new Map<string, ReturnType<typeof setInterval>>();
  const forget = (agentId: string): void => {
    clearInterval(timers.get(agentId));
    timers.delete(agentId);
  };
  const watch = (event: AgentHookEventPayload): void => {
    const { agentId, taskId, launchId } = event;
    let readyBefore = false;
    const check = (): void => {
      const screen = options.screenText(event);
      const ready = screen !== null && getAgentPromptReadiness(screen).ready;
      if (screen !== null && !(ready && readyBefore)) {
        // One sighting can be the frame between a prompt and its "Working" row.
        readyBefore = ready;
        return;
      }
      forget(agentId);
      if (screen === null) return;
      const at = (options.now ?? Date.now)();
      const detail = 'Stopped without a reply';
      options.onFailed({
        agentId,
        taskId,
        launchId,
        state: 'done',
        event: 'StopFailure',
        detail,
        at,
      });
    };
    timers.set(agentId, setInterval(check, options.checkMs ?? CHECK_MS));
  };
  return {
    note: (event) => {
      forget(event.agentId);
      if (event.state === 'working') watch(event);
    },
    stop: () => {
      for (const agentId of [...timers.keys()]) forget(agentId);
    },
  };
}
