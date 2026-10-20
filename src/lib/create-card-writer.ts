import { createSignal, onCleanup } from 'solid-js';
import { errMessage } from './log';
import { buildWriteCardPrompt, parseWrittenCards } from './thinking-prompt';
import { nodeTrail, type TourNode } from './tour-tree';
import { startUnderstandingRequest } from './understanding-request';
import type { TourCard } from './understanding-tour';

/** Cards the agent wrote from the reader's notes, waiting to be taken or left. */
export interface CardProposal {
  nodeId: string;
  cards: TourCard[];
}

/**
 * "Write card" in a tour the reader writes. One request at a time; its answer
 * is only proposed, so the reader's notes stay until they take it.
 */
export function createCardWriter() {
  /** The card being written, or ''. */
  const [writingId, setWritingId] = createSignal('');
  const [proposal, setProposal] = createSignal<CardProposal | null>(null);
  /** A failed write, kept with the card it was for. */
  const [failure, setFailure] = createSignal<{ nodeId: string; message: string } | null>(null);
  let request: { cancel: () => void } | undefined;
  /** Bumped by every write and cancel, so a late answer is dropped. */
  let token = 0;

  function cancel(): void {
    token += 1;
    request?.cancel();
    request = undefined;
    setWritingId('');
  }

  async function write(input: { roots: TourNode[]; nodeId: string; cwd: string }): Promise<void> {
    const trail = nodeTrail(input.roots, input.nodeId);
    const target = trail[trail.length - 1];
    if (!target) return;
    cancel();
    const active = token;
    setProposal(null);
    setFailure(null);
    setWritingId(input.nodeId);
    try {
      const prompt = buildWriteCardPrompt({
        roots: input.roots.map((node) => node.card),
        above: trail.slice(0, -1).map((node) => node.card),
        card: target.card,
      });
      const handle = startUnderstandingRequest({
        prompt,
        cwd: input.cwd,
        request: 'follow-up',
        onElapsed: () => {},
        onReceiving: () => {},
        // stderr can precede a success, so only the outcome below reports.
        onProviderError: () => {},
      });
      request = handle;
      const outcome = await handle.result;
      if (active !== token || outcome.status === 'cancelled') return;
      if (outcome.status === 'failed') throw new Error(outcome.message);
      setProposal({ nodeId: input.nodeId, cards: parseWrittenCards(outcome.text) });
    } catch (cause) {
      if (active === token)
        setFailure({
          nodeId: input.nodeId,
          message: `Could not write the card: ${errMessage(cause)}`,
        });
    } finally {
      if (active === token) {
        request = undefined;
        setWritingId('');
      }
    }
  }

  /** Leaves the proposal, and any failure, without touching the card. */
  function dismiss(): void {
    setProposal(null);
    setFailure(null);
  }

  /** Why writing the card `nodeId` failed, or ''. */
  function error(nodeId: string): string {
    const failed = failure();
    return failed?.nodeId === nodeId ? failed.message : '';
  }

  onCleanup(cancel);

  return { writingId, proposal, error, write, cancel, dismiss };
}
