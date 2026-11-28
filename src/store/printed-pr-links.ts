import { createSignal } from 'solid-js';
import { lastPrintedPrUrl } from '../../electron/shared/printed-pr-url';

/** The latest GitHub PR link a task's terminal or chat reported, as `gh pr create` does. */
export interface PrintedPrLink {
  taskId: string;
  url: string;
}

// A link can straddle two PTY chunks, so each scan reaches this far into the previous one.
const CHUNK_OVERLAP = 120;

const [printedPrLink, setPrintedPrLink] = createSignal<PrintedPrLink | null>(null);
// Terminal repaints and chat snapshots can report the same link repeatedly.
const lastLinkByAgentId = new Map<string, string>();

export { printedPrLink };

/** Records a PR link at the end of `tail`, the agent's output up to and including `chunk`. */
export function notePrintedPrLink(
  agentId: string,
  taskId: string,
  output: { tail: string; chunk: string },
): void {
  const recent = output.tail.slice(-(output.chunk.length + CHUNK_OVERLAP));
  const url = lastPrintedPrUrl(recent);
  if (url) noteAgentPrUrl(agentId, taskId, url);
}

export function noteAgentPrUrl(agentId: string, taskId: string, url: string): void {
  if (lastLinkByAgentId.get(agentId) === url) return;
  lastLinkByAgentId.set(agentId, url);
  setPrintedPrLink({ taskId, url });
}

export function forgetPrintedPrLink(agentId: string): void {
  lastLinkByAgentId.delete(agentId);
}
