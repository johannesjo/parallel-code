import { createSignal } from 'solid-js';

/** The latest GitHub PR link a task's terminal printed, as `gh pr create` does. */
export interface PrintedPrLink {
  taskId: string;
  url: string;
}

const PR_LINK_PATTERN = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
// A link can straddle two PTY chunks, so each scan reaches this far into the previous one.
const CHUNK_OVERLAP = 120;

const [printedPrLink, setPrintedPrLink] = createSignal<PrintedPrLink | null>(null);
// TUI agents repaint their screen, reprinting old links; only a new one counts.
const lastLinkByAgentId = new Map<string, string>();

export { printedPrLink };

/** Records a PR link at the end of `tail`, the agent's output up to and including `chunk`. */
export function notePrintedPrLink(
  agentId: string,
  taskId: string,
  output: { tail: string; chunk: string },
): void {
  const recent = output.tail.slice(-(output.chunk.length + CHUNK_OVERLAP));
  if (!recent.includes('/pull/')) return;
  const url = recent.match(PR_LINK_PATTERN)?.at(-1);
  if (!url || lastLinkByAgentId.get(agentId) === url) return;
  lastLinkByAgentId.set(agentId, url);
  setPrintedPrLink({ taskId, url });
}

export function forgetPrintedPrLink(agentId: string): void {
  lastLinkByAgentId.delete(agentId);
}
