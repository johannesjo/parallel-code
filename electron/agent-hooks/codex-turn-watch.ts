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

function showsFailedTurn(screen: string): boolean {
  // Codex separates entries with blank rows. A quoted line within an error
  // can start with '>', and the footer can repeat arbitrary prompt text.
  const blocks = screen.split(/\n(?:[ \t]*\n)+/).reverse();
  const latest = blocks.findIndex((block) => /^(?:[ \t]*[›>]|[■•◦] )/m.test(block));
  if (latest < 0 || !blocks[latest + 1]?.startsWith('■ ')) return false;
  const composer = blocks[latest];
  return /^[ \t]*[›>]/.test(composer) && getAgentPromptReadiness(composer).ready;
}

/**
 * Codex runs no hook when a turn fails (a model error, a usage limit), so its
 * last word would be "working" for good. The composer also appears during
 * work, so require an explicit error on two consecutive checks.
 */
export function createCodexTurnWatch(options: CodexTurnWatchOptions): CodexTurnWatch {
  const timers = new Map<string, ReturnType<typeof setInterval>>();
  const forget = (agentId: string): void => {
    clearInterval(timers.get(agentId));
    timers.delete(agentId);
  };
  const watch = (event: AgentHookEventPayload): void => {
    const { agentId, taskId, launchId } = event;
    let failedBefore = false;
    const check = (): void => {
      const screen = options.screenText(event);
      const failed = screen !== null && showsFailedTurn(screen);
      if (screen !== null && !(failed && failedBefore)) {
        failedBefore = failed;
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
