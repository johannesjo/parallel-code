import { createRoot } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTourQuestions } from './create-tour-questions';

const { startUnderstandingRequest } = vi.hoisted(() => ({ startUnderstandingRequest: vi.fn() }));
vi.mock('./understanding-request', () => ({ startUnderstandingRequest }));

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.clearAllMocks();
});

describe('createTourQuestions', () => {
  it('drops quotes from change-tour answers: there is no single text to check them against', async () => {
    const answer = {
      cards: [
        {
          label: 'WHY',
          title: 'The buffer moved',
          body: 'Fewer messages.',
          tone: 'neutral',
          source: 'An unchecked quote',
        },
      ],
    };
    startUnderstandingRequest.mockReturnValue({
      result: Promise.resolve({ status: 'done', text: JSON.stringify(answer) }),
      cancel: vi.fn(),
    });
    const questions = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return createTourQuestions();
    });
    await questions.ask({ question: 'Why?', fromIndex: 0, cwd: '/repo', buildPrompt: () => 'p' });
    const [thread] = questions.threadsFor(0);
    expect(thread.cards[0].title).toBe('The buffer moved');
    expect(thread.cards[0].source).toBeUndefined();
  });
});
