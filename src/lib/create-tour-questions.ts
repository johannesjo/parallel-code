import { createSignal, onCleanup } from 'solid-js';
import { errMessage } from './log';
import { startUnderstandingRequest } from './understanding-request';
import { groundBranch, parseTourBranch, type TourBranch } from './understanding-tour';

/**
 * Follow-up questions asked under the stops of a change tour. Answers stay in
 * threads under the stop they were asked from; one question runs at a time.
 * The understanding tour keeps its own copy of this logic inside its
 * controller, where it shares the generation token.
 */
export function createTourQuestions() {
  const [threads, setThreads] = createSignal<TourBranch[]>([]);
  const [pending, setPending] = createSignal<{ question: string; fromIndex: number } | null>(null);
  const [error, setError] = createSignal<{ message: string; fromIndex: number } | null>(null);
  let request: { cancel: () => void } | undefined;

  function cancel(): void {
    request?.cancel();
    request = undefined;
    setPending(null);
  }

  function reset(): void {
    cancel();
    setThreads([]);
    setError(null);
  }

  onCleanup(cancel);

  function threadsFor(index: number): TourBranch[] {
    return threads().filter((thread) => thread.fromIndex === index);
  }

  /**
   * Asks under stop `fromIndex`. `buildPrompt` runs here so a context that is
   * too large reports like any other failure.
   */
  async function ask(input: {
    question: string;
    fromIndex: number;
    cwd: string;
    buildPrompt: () => string;
  }): Promise<void> {
    const { question, fromIndex } = input;
    if (!question.trim() || pending()) return;
    setError(null);
    let prompt: string;
    try {
      prompt = input.buildPrompt();
    } catch (cause) {
      setError({ message: errMessage(cause), fromIndex });
      return;
    }
    setPending({ question, fromIndex });
    const handle = startUnderstandingRequest({
      prompt,
      cwd: input.cwd,
      request: 'follow-up',
      // The spinner in the ask bar carries the wait; stderr arrives again with the failure.
      onElapsed: () => {},
      onReceiving: () => {},
      onProviderError: () => {},
    });
    request = handle;
    const outcome = await handle.result;
    // Cancelled, reset or superseded while waiting.
    if (request !== handle) return;
    request = undefined;
    setPending(null);
    if (outcome.status === 'cancelled') return;
    try {
      if (outcome.status === 'failed') throw new Error(outcome.message);
      // A change tour has no single text to check quotes against, so none survive.
      const branch = groundBranch(parseTourBranch(outcome.text, fromIndex, question), 'change', '');
      setThreads([...threads(), branch]);
    } catch (cause) {
      setError({ message: errMessage(cause), fromIndex });
    }
  }

  return {
    threads,
    threadsFor,
    /** The question in flight under stop `index`, or '' when there is none. */
    pendingFor: (index: number) => {
      const inFlight = pending();
      return inFlight && inFlight.fromIndex === index ? inFlight.question : '';
    },
    asking: () => pending() !== null,
    /** A failed question belongs to its stop and is not shown under any other. */
    errorFor: (index: number) => {
      const failure = error();
      return failure && failure.fromIndex === index ? failure.message : '';
    },
    ask,
    cancel,
    reset,
  };
}
