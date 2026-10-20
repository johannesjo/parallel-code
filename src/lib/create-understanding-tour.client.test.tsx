import { createRoot } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import {
  TOUR_CARD_LIMITS,
  TOUR_FILE_CHANGED,
  TOUR_FILE_MAX_CARDS,
  TOUR_FILE_MAX_CHARS,
  UNDERSTANDING_MAX_OUTPUT_CHARS,
  UNDERSTANDING_TIMEOUT_MS,
} from '../../electron/shared/understanding-limits';
import {
  createUnderstandingTour,
  documentTourKind,
  type UnderstandingTourOptions,
} from './create-understanding-tour';
import { invoke } from './ipc';
import { info as logInfo } from './log';
import { GO_DEEPER_QUESTION } from './understanding-prompt';
import {
  GIST_LABEL,
  type FileTourContext,
  type TourCard,
  type UnderstandingTour,
} from './understanding-tour';

const channels = vi.hoisted(
  () =>
    [] as {
      onmessage: ((message: { type: string; text?: string; exitCode?: number }) => void) | null;
      dispose: () => void;
    }[],
);
vi.mock('./ipc', () => ({
  invoke: vi.fn(() => Promise.resolve()),
  Channel: class {
    onmessage = null;
    dispose = vi.fn();
    constructor() {
      channels.push(this);
    }
  },
}));
vi.mock('../store/store', async () => {
  const { createStore } = await import('solid-js/store');
  const [store] = createStore({ askCodeProvider: 'minimax', agentEnvFiles: {} });
  return { store };
});
vi.mock('./log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./log')>()),
  info: vi.fn(),
}));

const fileContext: FileTourContext = {
  filePath: 'src/pty.ts',
  files: [{ path: 'src/pty.ts', content: 'export const marker = "BUFFERED";', truncated: false }],
  omitted: ['../vendor/big.ts'],
};

const disposers: (() => void)[] = [];
beforeEach(() => {
  vi.mocked(invoke).mockImplementation(((channel: IPC) =>
    channel === IPC.ReadFileTourContext
      ? Promise.resolve(fileContext)
      : Promise.resolve(undefined)) as typeof invoke);
});
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  channels.length = 0;
  vi.clearAllMocks();
  vi.useRealTimers();
});

function card(over: Record<string, unknown> = {}) {
  return { label: 'KEY DECISION', title: 'Title', body: 'Body text.', tone: 'neutral', ...over };
}
const TOUR_JSON = JSON.stringify({
  gist: card({ label: GIST_LABEL, title: 'Gist title' }),
  cards: [card({ title: 'One' }), card({ title: 'Two' }), card({ title: 'Three' })],
});
const BRANCH_JSON = JSON.stringify({
  cards: [card({ title: 'Deep one' }), card({ title: 'Deep two' })],
});

/** Drains the microtask queue; works under fake timers. */
async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}
function stream(index: number, text: string, exitCode = 0) {
  channels[index]?.onmessage?.({ type: 'chunk', text });
  channels[index]?.onmessage?.({ type: 'done', exitCode });
}
function setup(options?: UnderstandingTourOptions) {
  let controller: ReturnType<typeof createUnderstandingTour> | undefined;
  disposers.push(
    createRoot((dispose) => {
      controller = createUnderstandingTour(options);
      return dispose;
    }),
  );
  if (!controller) throw new Error('Controller was not created');
  return controller;
}
const asks = () => vi.mocked(invoke).mock.calls.filter(([channel]) => channel === IPC.AskAboutCode);
const promptOf = (index: number) => String(asks()[index][1]?.prompt ?? '');
/** Just the context a follow-up replays, so a match cannot come from the spine. */
const replayedContext = (index: number) =>
  promptOf(index).split('contains the same context the tour was built from:\n')[1] ?? '';

const PLAN_INPUT = {
  kind: 'plan',
  taskName: 'Task',
  worktreePath: '/repo',
  planContent: '# Plan\n\nBuffer before IPC.',
  subject: 'output buffering',
} as const;

const FILE_INPUT = {
  kind: 'file',
  taskName: 'Task',
  worktreePath: '/repo',
  filePath: 'src/pty.ts',
} as const;

const AGENT_INPUT = {
  kind: 'agent',
  taskName: 'Task',
  worktreePath: '/repo',
  subject: 'the retry bug',
} as const;

/** Already validated cards, as `publish` receives them from the panel. */
const publishedCard = (title: string, label = 'KEY DECISION'): TourCard => ({
  label,
  title,
  body: 'Body text.',
  tone: 'neutral',
  refs: [],
});
const PUBLISHED_TOUR: UnderstandingTour = {
  subject: 'the retry bug',
  kind: 'agent',
  cards: [publishedCard('Published gist', GIST_LABEL), publishedCard('Published one')],
};

/** Titles and questions of the answers under one of the tour's own cards. */
function answersUnder(tour: ReturnType<typeof setup>, index: number) {
  return (tour.tree()[index]?.children ?? []).map((node) => ({
    title: node.card.title,
    question: node.question,
  }));
}
const answerCount = (tour: ReturnType<typeof setup>) =>
  tour.tree().reduce((count, root) => count + root.children.length, 0);

async function generatedPlanTour() {
  const tour = setup();
  void tour.generate(PLAN_INPUT);
  await flush();
  stream(0, TOUR_JSON);
  await flush();
  return tour;
}

describe('createUnderstandingTour', () => {
  it('generates a plan tour and opens on the gist card', async () => {
    const tour = setup();
    void tour.generate(PLAN_INPUT);
    await flush();
    expect(tour.loading()).toBe(true);
    expect(tour.subject()).toBe('output buffering');
    expect(tour.kind()).toBe('plan');
    expect(channels).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith(
      IPC.AskAboutCode,
      expect.objectContaining({
        purpose: 'understand',
        provider: 'minimax',
        cwd: '/repo',
        onOutput: channels[0],
      }),
    );
    expect(promptOf(0)).toContain('Buffer before IPC.');
    stream(0, TOUR_JSON);
    await flush();
    expect(tour.loading()).toBe(false);
    expect(tour.error()).toBe('');
    expect(tour.step()).toBe(0);
    // The gist is the first card of the spine, not a screen in front of it.
    expect(tour.tour()?.cards[0]?.title).toBe('Gist title');
    expect(tour.tour()?.cards).toHaveLength(4);
  });

  it('reads the file context before generating and inlines it in the prompt', async () => {
    const tour = setup();
    void tour.generate({
      kind: 'file',
      taskName: 'Task',
      worktreePath: '/repo',
      filePath: 'src/pty.ts',
    });
    expect(tour.progress()).toBe('Reading file…');
    expect(tour.subject()).toBe('src/pty.ts');
    await flush();
    expect(invoke).toHaveBeenCalledWith(IPC.ReadFileTourContext, {
      worktreePath: '/repo',
      filePath: 'src/pty.ts',
    });
    expect(tour.progress()).toBe('Generating tour…');
    expect(promptOf(0)).toContain('BUFFERED');
    expect(promptOf(0)).toContain('../vendor/big.ts');
    stream(0, TOUR_JSON);
    await flush();
    expect(tour.kind()).toBe('file');
    expect(tour.tour()?.subject).toBe('src/pty.ts');
  });

  it('reports a parse failure instead of a tour', async () => {
    const tour = setup();
    void tour.generate(PLAN_INPUT);
    await flush();
    stream(0, 'Sorry, no JSON here.');
    await flush();
    expect(tour.tour()).toBeNull();
    expect(tour.loading()).toBe(false);
    expect(tour.error()).not.toBe('');
  });

  it('reports a provider failure', async () => {
    const tour = setup();
    void tour.generate(PLAN_INPUT);
    await flush();
    channels[0].onmessage?.({ type: 'error', text: 'Provider unavailable' });
    expect(tour.error()).toBe('Provider unavailable');
    channels[0].onmessage?.({ type: 'done', exitCode: 1 });
    await flush();
    expect(tour.error()).toBe('Provider unavailable');
    expect(tour.tour()).toBeNull();
  });

  it('cancels mid-stream and ignores later chunks', async () => {
    const tour = setup();
    void tour.generate(PLAN_INPUT);
    await flush();
    channels[0].onmessage?.({ type: 'chunk', text: '{"gist"' });
    tour.cancel();
    expect(invoke).toHaveBeenCalledWith(IPC.CancelAskAboutCode, {
      requestId: expect.any(String),
    });
    stream(0, TOUR_JSON);
    await flush();
    expect(tour.tour()).toBeNull();
    expect(tour.loading()).toBe(false);
    expect(tour.error()).toBe('');
  });

  it('times out on the client deadline and ignores a late response', async () => {
    vi.useFakeTimers();
    const tour = setup();
    void tour.generate(PLAN_INPUT);
    await flush();
    vi.advanceTimersByTime(UNDERSTANDING_TIMEOUT_MS + 5000);
    await flush();
    expect(tour.error()).toContain('did not finish within five minutes');
    expect(tour.loading()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    stream(0, TOUR_JSON);
    await flush();
    expect(tour.tour()).toBeNull();
  });

  it('asks a follow-up, nests the answer under the card and opens it', async () => {
    const tour = await generatedPlanTour();
    tour.navigate(1);
    void tour.ask('Why buffer first?');
    await flush();
    expect(tour.asking()).toBe(true);
    expect(tour.pendingQuestion()).toBe('Why buffer first?');
    expect(tour.pending()).toEqual({ question: 'Why buffer first?', nodeId: tour.tree()[1].id });
    expect(channels).toHaveLength(2);
    expect(promptOf(1)).toContain('Why buffer first?');
    expect(promptOf(1)).toContain('Buffer before IPC.');
    stream(1, BRANCH_JSON);
    await flush();
    expect(tour.asking()).toBe(false);
    expect(tour.pendingQuestion()).toBe('');
    expect(answersUnder(tour, 1)).toEqual([
      { title: 'Deep one', question: 'Why buffer first?' },
      { title: 'Deep two', question: 'Why buffer first?' },
    ]);
    expect(answersUnder(tour, 0)).toEqual([]);
    // The reader lands on the first answer, still under the same tour card.
    expect(tour.currentNode()?.card.title).toBe('Deep one');
    expect(tour.step()).toBe(1);
    expect(tour.trail().map((node) => node.card.title)).toEqual(['One', 'Deep one']);
    // Within the answers, then out past the last one to the next tour card.
    tour.next();
    expect(tour.currentNode()?.card.title).toBe('Deep two');
    tour.next();
    expect(tour.currentNode()?.card.title).toBe('Two');
    // Back from a first answer leads out to the card it answers.
    tour.navigate(1);
    tour.select(tour.currentNode()?.children[0]?.id);
    expect(tour.currentNode()?.card.title).toBe('Deep one');
    tour.previous();
    expect(tour.currentNode()?.card.title).toBe('One');
    tour.select(tour.currentNode()?.children[0]?.id);
    tour.leave();
    expect(tour.currentNode()?.card.title).toBe('One');
  });

  it('answers a question asked on an answer under that answer', async () => {
    const tour = await generatedPlanTour();
    tour.navigate(1);
    void tour.ask('Why buffer first?');
    await flush();
    stream(1, BRANCH_JSON);
    await flush();
    void tour.ask('And the timer?');
    await flush();
    expect(promptOf(2)).toContain('went deeper from spine card 2 of 4');
    expect(promptOf(2)).toContain('"Deep one"');
    stream(2, JSON.stringify({ cards: [card({ title: 'Deeper still' })] }));
    await flush();
    expect(tour.trail().map((node) => node.card.title)).toEqual([
      'One',
      'Deep one',
      'Deeper still',
    ]);
  });

  it('digs into one point of a slide with a fixed question', async () => {
    const tour = await generatedPlanTour();
    tour.goDeeperOn('Buffers flush on a timer');
    await flush();
    expect(promptOf(1)).toContain('Go deeper on this point: Buffers flush on a timer');
  });

  it('stops nesting answers at the deepest level a saved tour can hold', async () => {
    const tour = await generatedPlanTour();
    for (let level = 1; level < 5; level += 1) {
      expect(tour.canAsk()).toBe(true);
      void tour.ask(`Level ${level}?`);
      await flush();
      stream(level, JSON.stringify({ cards: [card({ title: `Level ${level}` })] }));
      await flush();
    }
    expect(tour.trail()).toHaveLength(5);
    expect(tour.canAsk()).toBe(false);
    void tour.ask('Too deep?');
    await flush();
    expect(channels).toHaveLength(5);
  });

  it('shows the question in flight only under the card it was asked from', async () => {
    const tour = await generatedPlanTour();
    tour.navigate(1);
    void tour.ask('Why buffer first?');
    await flush();
    expect(tour.pendingQuestion()).toBe('Why buffer first?');
    // Reading on while the answer generates must not drag the question along.
    tour.next();
    expect(tour.pendingQuestion()).toBe('');
    tour.previous();
    expect(tour.pendingQuestion()).toBe('Why buffer first?');
    tour.next();
    stream(1, BRANCH_JSON);
    await flush();
    expect(tour.pendingQuestion()).toBe('');
    expect(answersUnder(tour, 1)).toHaveLength(2);
    expect(answersUnder(tour, 2)).toHaveLength(0);
    // A reader who moved on stays where they are.
    expect(tour.currentNode()?.card.title).toBe('Two');
  });

  it('clears provider stderr once the branch parses', async () => {
    const tour = await generatedPlanTour();
    void tour.ask('Why buffer first?');
    await flush();
    channels[1].onmessage?.({ type: 'error', text: 'provider warning on stderr' });
    expect(tour.error()).toBe('provider warning on stderr');
    stream(1, BRANCH_JSON);
    await flush();
    expect(answersUnder(tour, 0)).toHaveLength(2);
    expect(tour.error()).toBe('');
  });

  it('leaves a failed ask behind when the reader moves to another card', async () => {
    const tour = await generatedPlanTour();
    void tour.ask('Why?');
    await flush();
    stream(1, 'not json');
    await flush();
    expect(tour.error()).not.toBe('');
    tour.next();
    expect(tour.error()).toBe('');
    void tour.ask('And now?');
    await flush();
    stream(2, 'still not json');
    await flush();
    expect(tour.error()).not.toBe('');
    tour.previous();
    expect(tour.error()).toBe('');
  });

  it('drops a follow-up failure once the reader has moved to another card', async () => {
    const tour = await generatedPlanTour();
    tour.navigate(1);
    void tour.ask('Why buffer first?');
    await flush();
    tour.next();
    channels[1].onmessage?.({ type: 'error', text: 'provider warning on stderr' });
    stream(1, 'not json');
    await flush();
    // The question belonged to card 1, and so did its failure.
    expect(tour.error()).toBe('');
    expect(tour.asking()).toBe(false);
    expect(tour.pendingQuestion()).toBe('');
    expect(answerCount(tour)).toBe(0);
    // Asking again from the card the reader is on still reports its failure.
    void tour.ask('And here?');
    await flush();
    stream(2, 'not json either');
    await flush();
    expect(tour.error()).not.toBe('');
  });

  it('stops a follow-up on cancel and ignores its late chunks', async () => {
    const tour = await generatedPlanTour();
    void tour.ask('Why buffer first?');
    await flush();
    expect(tour.asking()).toBe(true);
    tour.cancel();
    expect(tour.asking()).toBe(false);
    expect(tour.pendingQuestion()).toBe('');
    stream(1, BRANCH_JSON);
    await flush();
    expect(answerCount(tour)).toBe(0);
  });

  it('keeps the answers of a cached tour when it is reopened', async () => {
    const tour = await generatedPlanTour();
    tour.navigate(2);
    void tour.ask('What breaks?');
    await flush();
    stream(1, BRANCH_JSON);
    await flush();
    void tour.generate(FILE_INPUT);
    await flush();
    stream(2, TOUR_JSON);
    await flush();
    expect(answerCount(tour)).toBe(0);

    expect(tour.open(PLAN_INPUT)).toBe(true);
    expect(answersUnder(tour, 2).map((answer) => answer.question)).toEqual([
      'What breaks?',
      'What breaks?',
    ]);
  });

  it('adds a second answer under the same card and replays the first', async () => {
    const tour = await generatedPlanTour();
    tour.navigate(1);
    void tour.ask('First?');
    await flush();
    stream(1, BRANCH_JSON);
    await flush();
    tour.leave();
    void tour.ask('Second?');
    await flush();
    expect(promptOf(2)).toContain('already answered');
    expect(promptOf(2)).toContain('Deep one');
    stream(2, JSON.stringify({ cards: [card({ title: 'Follow-on' })] }));
    await flush();
    expect(answersUnder(tour, 1).map((answer) => answer.question)).toEqual([
      'First?',
      'First?',
      'Second?',
    ]);
    // The first question's prompt carried no earlier answers.
    expect(promptOf(1)).not.toContain('already answered');
  });

  it('sends the fixed Go deeper question', async () => {
    const tour = await generatedPlanTour();
    tour.goDeeper();
    await flush();
    expect(promptOf(1)).toContain(GO_DEEPER_QUESTION);
  });

  it('clamps navigation to the spine bounds', async () => {
    const tour = await generatedPlanTour();
    tour.previous();
    expect(tour.step()).toBe(0);
    // Four cards on screen: the gist and the three the model sent.
    tour.next();
    tour.next();
    tour.next();
    tour.next();
    expect(tour.step()).toBe(3);
  });

  it('resets every piece of tour state', async () => {
    const tour = await generatedPlanTour();
    tour.navigate(1);
    void tour.ask('Why?');
    await flush();
    stream(1, BRANCH_JSON);
    await flush();
    tour.reset();
    expect(tour.tour()).toBeNull();
    expect(tour.kind()).toBeNull();
    expect(tour.subject()).toBe('');
    expect(tour.tree()).toHaveLength(0);
    expect(tour.pendingQuestion()).toBe('');
    expect(tour.step()).toBe(0);
    expect(tour.error()).toBe('');
  });

  it('retries the last generate input', async () => {
    const tour = setup();
    void tour.generate(PLAN_INPUT);
    await flush();
    stream(0, 'not json');
    await flush();
    expect(tour.error()).not.toBe('');
    tour.retry();
    await flush();
    expect(channels).toHaveLength(2);
    expect(tour.loading()).toBe(true);
    stream(1, TOUR_JSON);
    await flush();
    expect(tour.tour()?.cards[0]?.title).toBe('Gist title');
  });

  it('keeps a finished plan tour while a file tour is generated', async () => {
    const tour = await generatedPlanTour();
    expect(tour.isReady('plan', 'output buffering')).toBe(true);

    void tour.generate(FILE_INPUT);
    await flush();
    expect(tour.isLoading('file', 'src/pty.ts')).toBe(true);
    expect(tour.isLoading('plan', 'output buffering')).toBe(false);
    expect(tour.isReady('plan', 'output buffering')).toBe(true);
    stream(1, TOUR_JSON);
    await flush();
    expect(tour.isReady('file', 'src/pty.ts')).toBe(true);
    expect(tour.subject()).toBe('src/pty.ts');
  });

  it('switches to a cached tour without generating it again', async () => {
    const tour = await generatedPlanTour();
    void tour.generate(FILE_INPUT);
    await flush();
    stream(1, TOUR_JSON);
    await flush();
    const before = asks().length;

    expect(tour.open(PLAN_INPUT)).toBe(true);
    expect(tour.kind()).toBe('plan');
    expect(tour.subject()).toBe('output buffering');
    expect(tour.tour()?.subject).toBe('output buffering');
    expect(tour.step()).toBe(0);
    expect(asks()).toHaveLength(before);

    // The cached context comes back with the tour, so follow-ups still work.
    void tour.ask('Why buffer first?');
    await flush();
    expect(promptOf(before)).toContain('Buffer before IPC.');
  });

  it('keeps the reader in place when reopening the tour already on screen', async () => {
    const tour = await generatedPlanTour();
    tour.navigate(2);
    expect(tour.open(PLAN_INPUT)).toBe(true);
    expect(tour.step()).toBe(2);
  });

  it('drops a cached plan tour once the plan text has changed', async () => {
    const tour = await generatedPlanTour();
    const edited = { ...PLAN_INPUT, planContent: `${PLAN_INPUT.planContent}\nNew step.` };
    expect(tour.open(edited)).toBe(false);
    expect(tour.isReady('plan', 'output buffering')).toBe(false);
    // The same text opens again; only the content decides, not the object.
    void tour.generate(edited);
    await flush();
    stream(1, TOUR_JSON);
    await flush();
    expect(tour.open({ ...edited })).toBe(true);
  });

  it('routes only the real plan path to a plan tour', () => {
    expect(documentTourKind({ planPath: 'docs/plan.md' }, 'docs/plan.md')).toBe('plan');
    expect(documentTourKind({ planPath: 'docs/plan.md' }, 'README.md')).toBe('document');
    expect(documentTourKind({}, 'plan.md')).toBe('document');
  });

  it('generates a document tour, grounded in the document it explains', async () => {
    const tour = setup();
    const input = {
      kind: 'document',
      taskName: 'Task',
      worktreePath: '/repo',
      content: '# Guide\n\nAlways run the migration first.\n\n## Appendix\n\nTables.',
      subject: 'docs/guide.md',
    } as const;
    void tour.generate(input);
    await flush();
    expect(promptOf(0)).toContain('You explain a Markdown document');
    stream(
      0,
      JSON.stringify({
        gist: card({ title: 'Gist title', source: 'Always run the migration first.' }),
        cards: [card({ title: 'One', source: 'Never run the migration.' })],
        omitted: ['Appendix', 'Made up'],
      }),
    );
    await flush();
    const shown = tour.tour();
    expect(shown?.kind).toBe('document');
    expect(shown?.cards[0].source).toBe('Always run the migration first.');
    expect(shown?.cards[1].source).toBeUndefined();
    expect(shown?.omitted).toEqual(['Appendix']);
    expect(tour.isReady('document', 'docs/guide.md')).toBe(true);
    expect(tour.open({ ...input, content: `${input.content}\nMore.` })).toBe(false);
  });

  it('flags a reopened file tour once the file has changed, without regenerating it', async () => {
    const tour = setup();
    void tour.generate(FILE_INPUT);
    await flush();
    stream(0, TOUR_JSON);
    await flush();
    expect(tour.open(FILE_INPUT)).toBe(true);
    await flush();
    expect(tour.stale()).toBe(false);

    const edited = { ...fileContext, files: [{ ...fileContext.files[0], content: 'changed' }] };
    vi.mocked(invoke).mockImplementation(((channel: IPC) =>
      channel === IPC.ReadFileTourContext
        ? Promise.resolve(edited)
        : Promise.resolve(undefined)) as typeof invoke);
    expect(tour.open(FILE_INPUT)).toBe(true);
    await flush();
    expect(tour.stale()).toBe(true);
    expect(tour.tour()?.cards[0]?.title).toBe('Gist title');
    expect(asks()).toHaveLength(1);

    // Regenerate reads the file again and clears the flag.
    tour.retry();
    await flush();
    expect(tour.stale()).toBe(false);
    expect(promptOf(1)).toContain('changed');
  });

  it("reworks the tour with the reader's request and repeats it on retry", async () => {
    const tour = await generatedPlanTour();
    void tour.ask('Why?');
    await flush();
    stream(1, BRANCH_JSON);
    await flush();
    expect(answerCount(tour)).toBe(2);

    tour.rework('Explain it for a newcomer');
    await flush();
    expect(tour.progress()).toBe('Reworking tour…');
    expect(promptOf(2)).toContain('"Explain it for a newcomer"');
    expect(promptOf(2)).toContain('Buffer before IPC.');
    stream(2, JSON.stringify({ gist: card({ title: 'Simpler gist' }), cards: [card()] }));
    await flush();
    expect(tour.tour()?.cards[0]?.title).toBe('Simpler gist');
    expect(answerCount(tour)).toBe(0);
    // The reworked tour replaces the cached one, so the entry button reopens it.
    expect(tour.open(PLAN_INPUT)).toBe(true);
    expect(tour.tour()?.cards[0]?.title).toBe('Simpler gist');

    tour.retry();
    await flush();
    expect(promptOf(3)).toContain('"Explain it for a newcomer"');
  });

  it('reworks a published tour from the material the agent supplied', async () => {
    const tour = setup();
    tour.publish({
      subject: 'the retry bug',
      tour: PUBLISHED_TOUR,
      context: 'The agent read the retry loop.',
      worktreePath: '/repo',
    });
    tour.rework('Shorter');
    await flush();
    expect(promptOf(0)).toContain('The agent read the retry loop.');
    expect(promptOf(0)).toContain('"Shorter"');
    stream(0, TOUR_JSON);
    await flush();
    expect(tour.kind()).toBe('agent');
    expect(tour.tour()?.cards[0]?.title).toBe('Gist title');
  });

  it('publishes an agent tour without a provider call and reopens it from the cache', () => {
    const onReady = vi.fn();
    const tour = setup({ onReady });
    tour.publish({
      subject: 'the retry bug',
      tour: PUBLISHED_TOUR,
      context: 'The agent read the retry loop.',
      worktreePath: '/repo',
    });
    expect(asks()).toHaveLength(0);
    expect(tour.kind()).toBe('agent');
    expect(tour.subject()).toBe('the retry bug');
    expect(tour.step()).toBe(0);
    expect(tour.tour()?.cards[0]?.title).toBe('Published gist');
    expect(tour.isReady('agent', 'the retry bug')).toBe(true);
    expect(onReady).toHaveBeenCalledExactlyOnceWith('the retry bug');
    // Another subject's tour is on screen, so the agent input has to reopen this one.
    tour.reset();
    expect(tour.open(AGENT_INPUT)).toBe(false);
  });

  it('replays the published context to a follow-up, or the cards when there is none', async () => {
    const tour = setup();
    tour.publish({
      subject: 'the retry bug',
      tour: PUBLISHED_TOUR,
      context: 'The agent read the retry loop.',
      worktreePath: '/repo',
    });
    void tour.ask('Why does it retry twice?');
    await flush();
    expect(replayedContext(0)).toContain('The agent read the retry loop.');
    expect(promptOf(0)).toContain('the topic "the retry bug"');
    stream(0, BRANCH_JSON);
    await flush();
    expect(answersUnder(tour, 0)).toHaveLength(2);

    // Without a context the cards themselves are all a follow-up can reason from.
    tour.publish({
      subject: 'no context',
      tour: PUBLISHED_TOUR,
      context: '',
      worktreePath: '/repo',
    });
    void tour.ask('And why not once?');
    await flush();
    expect(replayedContext(1)).toContain('Published one');
  });

  it('keeps a published tour reopenable while another tour is on screen', async () => {
    const tour = await generatedPlanTour();
    tour.publish({
      subject: 'the retry bug',
      tour: PUBLISHED_TOUR,
      context: 'The agent read the retry loop.',
      worktreePath: '/repo',
    });
    expect(tour.open(PLAN_INPUT)).toBe(true);
    expect(tour.kind()).toBe('plan');
    expect(tour.open(AGENT_INPUT)).toBe(true);
    expect(tour.kind()).toBe('agent');
    expect(tour.tour()?.cards[0]?.title).toBe('Published gist');
    expect(tour.step()).toBe(0);
  });

  it('saves the tour into the worktree once, then keeps the file up to date', async () => {
    const tour = await generatedPlanTour();
    vi.mocked(invoke).mockImplementation(((channel: IPC, args?: { path?: string }) =>
      channel === IPC.SaveTourFile
        ? Promise.resolve(
            args?.path === 'output-buffering.tour.md' ? 'output-buffering-2.tour.md' : args?.path,
          )
        : Promise.resolve(undefined)) as typeof invoke);
    const saves = () =>
      vi.mocked(invoke).mock.calls.filter(([channel]) => channel === IPC.SaveTourFile);
    await tour.save();
    expect(saves()).toHaveLength(1);
    expect(saves()[0][1]).toMatchObject({
      worktreePath: '/repo',
      path: 'output-buffering.tour.md',
      replace: false,
    });
    const first = String(saves()[0][1]?.content);
    expect(first).toContain('kind: plan');
    expect(first).toContain('## Gist title');
    // The backend picked a free name; that is the file from now on.
    expect(tour.savedPath()).toBe('output-buffering-2.tour.md');

    void tour.ask('Why buffer first?');
    await flush();
    stream(1, BRANCH_JSON);
    await flush();
    await flush();
    expect(saves()).toHaveLength(2);
    expect(saves()[1][1]).toMatchObject({ path: 'output-buffering-2.tour.md', replace: true });
    expect(String(saves()[1][1]?.content)).toContain('### Deep one');

    // Reopening the cached tour keeps saving to the same file.
    void tour.generate(FILE_INPUT);
    await flush();
    stream(2, TOUR_JSON);
    await flush();
    expect(tour.savedPath()).toBe('');
    expect(tour.open(PLAN_INPUT)).toBe(true);
    expect(tour.savedPath()).toBe('output-buffering-2.tour.md');
  });

  it('reports a failed save on the tour instead of losing it silently', async () => {
    const tour = await generatedPlanTour();
    vi.mocked(invoke).mockImplementation(((channel: IPC) =>
      channel === IPC.SaveTourFile
        ? Promise.reject(new Error('disk full'))
        : Promise.resolve(undefined)) as typeof invoke);
    await tour.save();
    expect(tour.error()).toBe('Could not save the tour: disk full');
    expect(tour.savedPath()).toBe('');
    expect(tour.saving()).toBe(false);
  });

  it('restores a saved tour with its answers and replays the document it explains', async () => {
    const tour = setup();
    const { parseTourFile, serializeTour } = await import('./tour-file');
    const text = serializeTour(
      {
        subject: 'docs/cache.md',
        kind: 'document',
        source: 'docs/cache.md',
        roots: [
          {
            id: 'x',
            card: publishedCard('Reads dominate', GIST_LABEL),
            children: [
              { id: 'y', card: publishedCard('Measured weekly'), question: 'How?', children: [] },
            ],
          },
          { id: 'z', card: publishedCard('Writes stay simple'), children: [] },
        ],
      },
      { forFile: true },
    );
    await tour.restore({
      file: parseTourFile(text),
      text,
      savedPath: 'cache.tour.md',
      worktreePath: '/repo',
      taskName: 'Task',
      sourceText: '# Cache\n\nReads are 90% of traffic.',
    });
    expect(asks()).toHaveLength(0);
    expect(tour.kind()).toBe('document');
    expect(tour.subject()).toBe('docs/cache.md');
    expect(tour.savedPath()).toBe('cache.tour.md');
    expect(tour.currentNode()?.card.title).toBe('Reads dominate');
    expect(tour.tree()[0].children[0].question).toBe('How?');
    tour.select(tour.currentNode()?.children[0]?.id);
    expect(tour.currentNode()?.card.title).toBe('Measured weekly');
    // Reopening the unchanged file keeps the reader's place.
    await tour.restore({
      file: parseTourFile(text),
      text,
      savedPath: 'cache.tour.md',
      worktreePath: '/repo',
      taskName: 'Task',
      sourceText: '# Cache\n\nReads are 90% of traffic.',
    });
    expect(tour.currentNode()?.card.title).toBe('Measured weekly');
    void tour.ask('Why weekly?');
    await flush();
    expect(promptOf(0)).toContain('Reads are 90% of traffic.');
    expect(promptOf(0)).toContain('went deeper from spine card 1 of 2');
    // The file is its own tour; the document's Take Tour still makes or opens its own.
    expect(tour.isReady('document', 'docs/cache.md')).toBe(false);
  });

  it('never lets a reopened file replace a generated tour and its unsaved answers', async () => {
    const tour = await generatedPlanTour();
    void tour.ask('Why buffer first?');
    await flush();
    stream(1, BRANCH_JSON);
    await flush();
    const { parseTourFile } = await import('./tour-file');
    const text = `---\nparallel-code-tour: 1\nkind: plan\nsource: "output buffering"\n---\n## Saved card\n- a point\n`;
    await tour.restore({
      file: parseTourFile(text),
      text,
      savedPath: 'old.tour.md',
      worktreePath: '/repo',
      taskName: 'Task',
      sourceText: PLAN_INPUT.planContent,
    });
    expect(tour.currentNode()?.card.title).toBe('Saved card');
    expect(tour.open(PLAN_INPUT)).toBe(true);
    expect(tour.currentNode()?.card.title).toBe('Gist title');
    expect(answerCount(tour)).toBe(2);
  });

  it('lets go of a saved file edited outside the tour instead of writing over it', async () => {
    const tour = await generatedPlanTour();
    let onDisk = '';
    vi.mocked(invoke).mockImplementation(((
      channel: IPC,
      args?: { path?: string; content?: string; expected?: string },
    ) => {
      if (channel !== IPC.SaveTourFile) return Promise.resolve(undefined);
      if (args?.expected !== undefined && args.expected !== onDisk)
        return Promise.reject(new Error(`Error invoking remote method: ${TOUR_FILE_CHANGED}`));
      onDisk = args?.content ?? '';
      return Promise.resolve(args?.path);
    }) as typeof invoke);
    await tour.save();
    expect(tour.savedPath()).toBe('output-buffering.tour.md');
    // Someone edits the file; the next answer must not overwrite it.
    onDisk = 'edited by hand';
    void tour.ask('Why buffer first?');
    await flush();
    stream(1, BRANCH_JSON);
    await flush();
    await flush();
    expect(onDisk).toBe('edited by hand');
    expect(tour.savedPath()).toBe('');
    expect(tour.error()).toContain(
      'output-buffering.tour.md was changed or removed outside the tour',
    );
  });

  it('falls back to the cards when what a saved tour explains is gone', async () => {
    const tour = setup();
    const { parseTourFile } = await import('./tour-file');
    vi.mocked(invoke).mockImplementation(((channel: IPC) =>
      channel === IPC.ReadFileTourContext
        ? Promise.reject(new Error('missing'))
        : Promise.resolve(undefined)) as typeof invoke);
    const text =
      '---\nparallel-code-tour: 1\nkind: file\nsource: "src/gone.ts"\n---\n## Only card\n- a point\n';
    await tour.restore({
      file: parseTourFile(text),
      text,
      savedPath: 'gone.tour.md',
      worktreePath: '/repo',
      taskName: 'Task',
    });
    expect(tour.kind()).toBe('agent');
    void tour.ask('What did it do?');
    await flush();
    expect(promptOf(0)).toContain('Only card');
  });

  it('runs a reopened tour whose source is gone as a tour of its cards, but saves its kind', async () => {
    const tour = setup();
    const { parseTourFile } = await import('./tour-file');
    vi.mocked(invoke).mockImplementation(((channel: IPC, args?: { path?: string }) =>
      channel === IPC.SaveTourFile
        ? Promise.resolve(args?.path)
        : Promise.resolve(undefined)) as typeof invoke);
    const text =
      '---\nparallel-code-tour: 1\nkind: document\nsource: "docs/gone.md"\n---\n## Only card\n- a point\n';
    await tour.restore({
      file: parseTourFile(text),
      text,
      savedPath: 'gone.tour.md',
      worktreePath: '/repo',
      taskName: 'Task',
    });
    // No document to quote from, so follow-ups ask for no quotes.
    expect(tour.tour()?.kind).toBe('agent');
    void tour.ask('Why?');
    await flush();
    expect(promptOf(0)).not.toContain('verbatim excerpt');
    stream(0, BRANCH_JSON);
    await flush();
    await flush();
    const saved = vi.mocked(invoke).mock.calls.filter(([channel]) => channel === IPC.SaveTourFile);
    expect(String(saved.at(-1)?.[1]?.content)).toContain('kind: document');
    expect(String(saved.at(-1)?.[1]?.content)).toContain('source: "docs/gone.md"');
  });

  it('recovers from a failed update without later claiming the file changed', async () => {
    const tour = await generatedPlanTour();
    let onDisk = '';
    let failNext = false;
    vi.mocked(invoke).mockImplementation(((
      channel: IPC,
      args?: { path?: string; content?: string; expected?: string },
    ) => {
      if (channel !== IPC.SaveTourFile) return Promise.resolve(undefined);
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error('disk full'));
      }
      if (args?.expected !== undefined && args.expected !== onDisk)
        return Promise.reject(new Error(TOUR_FILE_CHANGED));
      onDisk = args?.content ?? '';
      return Promise.resolve(args?.path);
    }) as typeof invoke);
    await tour.save();
    failNext = true;
    void tour.ask('First?');
    await flush();
    stream(1, BRANCH_JSON);
    await flush();
    await flush();
    expect(tour.error()).toContain('disk full');
    void tour.ask('Second?');
    await flush();
    stream(2, BRANCH_JSON);
    await flush();
    await flush();
    expect(tour.savedPath()).toBe('output-buffering.tour.md');
    expect(onDisk).toContain('### Deep one');
    expect(tour.error()).toBe('');
  });

  it('never regenerates a tour reopened from its file', async () => {
    const tour = await generatedPlanTour();
    void tour.ask('Why buffer first?');
    await flush();
    stream(1, BRANCH_JSON);
    await flush();
    const { parseTourFile } = await import('./tour-file');
    const text = `---\nparallel-code-tour: 1\nkind: plan\nsource: "output buffering"\n---\n## Saved card\n- a point\n`;
    await tour.restore({
      file: parseTourFile(text),
      text,
      savedPath: 'old.tour.md',
      worktreePath: '/repo',
      taskName: 'Task',
      sourceText: PLAN_INPUT.planContent,
    });
    expect(tour.fromFile()).toBe(true);
    tour.rework('Shorter');
    tour.retry();
    await flush();
    expect(asks()).toHaveLength(2);
    expect(tour.currentNode()?.card.title).toBe('Saved card');
    expect(tour.open(PLAN_INPUT)).toBe(true);
    expect(tour.fromFile()).toBe(false);
    expect(answerCount(tour)).toBe(2);
  });

  it('writes answers that arrive while the first save is still running', async () => {
    const tour = await generatedPlanTour();
    let release: (path: string) => void = () => {};
    const contents: string[] = [];
    vi.mocked(invoke).mockImplementation(((
      channel: IPC,
      args?: { path?: string; content?: string; replace?: boolean },
    ) => {
      if (channel !== IPC.SaveTourFile) return Promise.resolve(undefined);
      contents.push(args?.content ?? '');
      if (args?.replace) return Promise.resolve(args.path);
      return new Promise<string>((resolve) => (release = resolve));
    }) as typeof invoke);
    const saving = tour.save();
    await flush();
    void tour.ask('Why buffer first?');
    await flush();
    stream(1, BRANCH_JSON);
    await flush();
    release('output-buffering.tour.md');
    await saving;
    await flush();
    expect(contents).toHaveLength(2);
    expect(contents[0]).not.toContain('Deep one');
    expect(contents[1]).toContain('### Deep one');
  });

  it('expects what last landed on disk, even with a write queued behind a failure', async () => {
    const tour = await generatedPlanTour();
    let onDisk = '';
    let holdNext = false;
    let failHeld: () => void = () => {};
    vi.mocked(invoke).mockImplementation(((
      channel: IPC,
      args?: { path?: string; content?: string; expected?: string },
    ) => {
      if (channel !== IPC.SaveTourFile) return Promise.resolve(undefined);
      if (holdNext) {
        holdNext = false;
        // This write fails only after the next one has queued behind it.
        return new Promise((_resolve, reject) => {
          failHeld = () => reject(new Error('EACCES'));
        });
      }
      if (args?.expected !== undefined && args.expected !== onDisk)
        return Promise.reject(new Error(TOUR_FILE_CHANGED));
      onDisk = args?.content ?? '';
      return Promise.resolve(args?.path);
    }) as typeof invoke);
    await tour.save();
    holdNext = true;
    tour.navigate(1);
    void tour.ask('First?');
    await flush();
    stream(1, BRANCH_JSON);
    await flush();
    tour.navigate(2);
    void tour.ask('Second?');
    await flush();
    stream(2, BRANCH_JSON);
    await flush();
    failHeld();
    await flush();
    await flush();
    expect(tour.savedPath()).toBe('output-buffering.tour.md');
    expect(onDisk).toContain('Second?');
  });

  it('drops queued updates once one finds the file edited outside the tour', async () => {
    const tour = await generatedPlanTour();
    let onDisk = '';
    let holdNext = false;
    let conflictHeld: () => void = () => {};
    vi.mocked(invoke).mockImplementation(((
      channel: IPC,
      args?: { path?: string; content?: string; expected?: string },
    ) => {
      if (channel !== IPC.SaveTourFile) return Promise.resolve(undefined);
      if (holdNext) {
        holdNext = false;
        return new Promise((_resolve, reject) => {
          conflictHeld = () => reject(new Error(TOUR_FILE_CHANGED));
        });
      }
      if (args?.expected !== undefined && args.expected !== onDisk)
        return Promise.reject(new Error(TOUR_FILE_CHANGED));
      onDisk = args?.content ?? '';
      return Promise.resolve(args?.path);
    }) as typeof invoke);
    await tour.save();
    onDisk = 'edited by hand';
    holdNext = true;
    void tour.ask('First?');
    await flush();
    stream(1, BRANCH_JSON);
    await flush();
    tour.navigate(2);
    void tour.ask('Second?');
    await flush();
    stream(2, BRANCH_JSON);
    await flush();
    conflictHeld();
    await flush();
    await flush();
    expect(onDisk).toBe('edited by hand');
    expect(tour.savedPath()).toBe('');
    expect(tour.error()).toContain('was changed or removed outside the tour');
  });

  it('keeps unsaved answers retryable after a failed update', async () => {
    const tour = await generatedPlanTour();
    let onDisk = '';
    let failNext = false;
    vi.mocked(invoke).mockImplementation(((
      channel: IPC,
      args?: { path?: string; content?: string; expected?: string },
    ) => {
      if (channel !== IPC.SaveTourFile) return Promise.resolve(undefined);
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error('disk full'));
      }
      if (args?.expected !== undefined && args.expected !== onDisk)
        return Promise.reject(new Error(TOUR_FILE_CHANGED));
      onDisk = args?.content ?? '';
      return Promise.resolve(args?.path);
    }) as typeof invoke);
    await tour.save();
    expect(tour.unsaved()).toBe(false);
    failNext = true;
    void tour.ask('First?');
    await flush();
    stream(1, BRANCH_JSON);
    await flush();
    await flush();
    expect(tour.unsaved()).toBe(true);
    tour.navigate(1);
    // Moving on clears the message, but the tour still knows it is behind.
    expect(tour.unsaved()).toBe(true);
    await tour.save();
    await flush();
    expect(onDisk).toContain('### Deep one');
    expect(tour.unsaved()).toBe(false);
    expect(tour.savedPath()).toBe('output-buffering.tour.md');
  });

  it('reopens a just-saved file as its own record, with the source read now', async () => {
    const tour = await generatedPlanTour();
    let onDisk = '';
    vi.mocked(invoke).mockImplementation(((
      channel: IPC,
      args?: { path?: string; content?: string },
    ) => {
      if (channel !== IPC.SaveTourFile) return Promise.resolve(undefined);
      onDisk = args?.content ?? '';
      return Promise.resolve(args?.path);
    }) as typeof invoke);
    await tour.save();
    const { parseTourFile } = await import('./tour-file');
    const reopen = (sourceText: string) =>
      tour.restore({
        file: parseTourFile(onDisk),
        text: onDisk,
        savedPath: 'output-buffering.tour.md',
        worktreePath: '/repo',
        taskName: 'Task',
        sourceText,
      });
    await reopen(PLAN_INPUT.planContent);
    expect(tour.fromFile()).toBe(true);
    await reopen('# Plan\n\nThe plan as it reads now.');
    void tour.ask('Why?');
    await flush();
    // Request 0 generated the tour; 1 is the follow-up on the reopened file.
    expect(replayedContext(1)).toContain('The plan as it reads now.');
  });

  it('reopens a hand-formatted file as saved, and keeps unsaved answers across a reopen', async () => {
    const tour = setup();
    const { parseTourFile, serializeTour } = await import('./tour-file');
    const canonical = serializeTour(
      {
        subject: 'docs/cache.md',
        kind: 'document',
        source: 'docs/cache.md',
        roots: [{ id: 'x', card: publishedCard('Reads dominate', GIST_LABEL), children: [] }],
      },
      { forFile: true },
    );
    // An editor saved it with CRLF line endings and extra blank lines.
    const text = `${canonical.replace(/\n/g, '\r\n')}\r\n\r\n`;
    let onDisk = text;
    let failNext = false;
    vi.mocked(invoke).mockImplementation(((
      channel: IPC,
      args?: { path?: string; content?: string; expected?: string },
    ) => {
      if (channel !== IPC.SaveTourFile) return Promise.resolve(undefined);
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error('disk full'));
      }
      if (args?.expected !== undefined && args.expected !== onDisk)
        return Promise.reject(new Error(TOUR_FILE_CHANGED));
      onDisk = args?.content ?? '';
      return Promise.resolve(args?.path);
    }) as typeof invoke);
    const reopen = () =>
      tour.restore({
        file: parseTourFile(onDisk),
        text: onDisk,
        savedPath: 'cache.tour.md',
        worktreePath: '/repo',
        taskName: 'Task',
        sourceText: '# Cache',
      });
    await reopen();
    expect(tour.unsaved()).toBe(false);
    failNext = true;
    void tour.ask('Why?');
    await flush();
    stream(0, BRANCH_JSON);
    await flush();
    await flush();
    expect(onDisk).toBe(text);
    expect(tour.unsaved()).toBe(true);
    // The file is as the tour last read it, so reopening keeps the answers.
    await reopen();
    expect(answerCount(tour)).toBe(2);
    expect(tour.unsaved()).toBe(true);
    await tour.save();
    await flush();
    expect(onDisk).toContain('### Deep one');
    expect(tour.unsaved()).toBe(false);
  });

  it('reports saving only for the tour whose file is being written', async () => {
    const tour = await generatedPlanTour();
    let release: () => void = () => {};
    let hold = false;
    vi.mocked(invoke).mockImplementation(((channel: IPC, args?: { path?: string }) => {
      if (channel !== IPC.SaveTourFile) return Promise.resolve(undefined);
      if (!hold) return Promise.resolve(args?.path);
      return new Promise<string | undefined>((resolve) => (release = () => resolve(args?.path)));
    }) as typeof invoke);
    await tour.save();
    hold = true;
    void tour.ask('Why?');
    await flush();
    stream(1, BRANCH_JSON);
    await flush();
    expect(tour.saving()).toBe(true);
    void tour.generate(FILE_INPUT);
    await flush();
    stream(2, TOUR_JSON);
    await flush();
    expect(tour.saving()).toBe(false);
    release();
    await flush();
  });

  it('leaves a reopened file to its own record when an earlier update lands late', async () => {
    const tour = await generatedPlanTour();
    let onDisk = '';
    let release: () => void = () => {};
    let hold = false;
    vi.mocked(invoke).mockImplementation(((
      channel: IPC,
      args?: { path?: string; content?: string },
    ) => {
      if (channel !== IPC.SaveTourFile) return Promise.resolve(undefined);
      if (!hold) {
        onDisk = args?.content ?? '';
        return Promise.resolve(args?.path);
      }
      return new Promise<string | undefined>((resolve) => (release = () => resolve(args?.path)));
    }) as typeof invoke);
    await tour.save();
    hold = true;
    void tour.ask('Why?');
    await flush();
    stream(1, BRANCH_JSON);
    await flush();
    const { parseTourFile } = await import('./tour-file');
    await tour.restore({
      file: parseTourFile(onDisk),
      text: onDisk,
      savedPath: 'output-buffering.tour.md',
      worktreePath: '/repo',
      taskName: 'Task',
      sourceText: PLAN_INPUT.planContent,
    });
    release();
    await flush();
    expect(tour.open(PLAN_INPUT)).toBe(true);
    expect(tour.savedPath()).toBe('');
  });

  it('reopens a saved file tour with the file as it reads now, or once it is back', async () => {
    const tour = setup();
    const { parseTourFile } = await import('./tour-file');
    let content: string | undefined;
    vi.mocked(invoke).mockImplementation(((channel: IPC) => {
      if (channel !== IPC.ReadFileTourContext) return Promise.resolve(undefined);
      if (content === undefined) return Promise.reject(new Error('missing'));
      return Promise.resolve({ ...fileContext, files: [{ ...fileContext.files[0], content }] });
    }) as typeof invoke);
    const text =
      '---\nparallel-code-tour: 1\nkind: file\nsource: "src/pty.ts"\n---\n## Only card\n- a point\n';
    const reopen = () =>
      tour.restore({
        file: parseTourFile(text),
        text,
        savedPath: 'pty.tour.md',
        worktreePath: '/repo',
        taskName: 'Task',
      });
    await reopen();
    expect(tour.kind()).toBe('agent');
    content = 'export const marker = "FIRST";';
    await reopen();
    expect(tour.kind()).toBe('file');
    content = 'export const marker = "SECOND";';
    await reopen();
    void tour.ask('Why?');
    await flush();
    expect(promptOf(0)).toContain('SECOND');
    expect(promptOf(0)).not.toContain('FIRST');
  });

  it('shows the file opened last when two saved file tours are read at once', async () => {
    const tour = setup();
    const { parseTourFile } = await import('./tour-file');
    const reads: (() => void)[] = [];
    vi.mocked(invoke).mockImplementation(((channel: IPC) =>
      channel === IPC.ReadFileTourContext
        ? new Promise<FileTourContext>((resolve) => reads.push(() => resolve(fileContext)))
        : Promise.resolve(undefined)) as typeof invoke);
    const reopen = (subject: string) => {
      const text = `---\nparallel-code-tour: 1\nkind: file\nsubject: "${subject}"\nsource: "src/pty.ts"\n---\n## ${subject}\n- a point\n`;
      return tour.restore({
        file: parseTourFile(text),
        text,
        savedPath: `${subject}.tour.md`,
        worktreePath: '/repo',
        taskName: 'Task',
      });
    };
    const first = reopen('first');
    const second = reopen('second');
    reads[0]();
    await first;
    reads[1]();
    await second;
    expect(tour.savedPath()).toBe('second.tour.md');
  });

  it('stops asking before the tour holds more cards than its file can', async () => {
    const tour = setup();
    const { parseTourFile, serializeTour } = await import('./tour-file');
    const roots = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `n${index}`,
        card: publishedCard(`Card ${index}`),
        children: [],
      }));
    const reopen = async (count: number) => {
      const text = serializeTour(
        { subject: 'big', kind: 'agent', roots: roots(count) },
        { forFile: true },
      );
      await tour.restore({
        file: parseTourFile(text),
        text,
        savedPath: `big-${count}.tour.md`,
        worktreePath: '/repo',
        taskName: 'Task',
      });
    };
    await reopen(TOUR_FILE_MAX_CARDS - TOUR_CARD_LIMITS.branchMaxCards);
    expect(tour.canAsk()).toBe(true);
    await reopen(TOUR_FILE_MAX_CARDS - TOUR_CARD_LIMITS.branchMaxCards + 1);
    expect(tour.canAsk()).toBe(false);
    expect(tour.askLimit()).toBe('cards');
  });

  it('stops asking before an answer could make the tour too large to save', async () => {
    const tour = setup();
    const { parseTourFile, serializeTour } = await import('./tour-file');
    // Spread over cards of 4000 characters, well inside what a file's card may hold.
    const reopen = async (bodyChars: number) => {
      const roots = Array.from({ length: Math.ceil(bodyChars / 4000) }, (_, index) => ({
        id: `n${index}`,
        card: {
          ...publishedCard(`Card ${index}`),
          body: 'x'.repeat(Math.min(4000, bodyChars - index * 4000)),
        },
        children: [],
      }));
      const text = serializeTour({ subject: 'long', kind: 'agent', roots }, { forFile: true });
      await tour.restore({
        file: parseTourFile(text),
        text,
        savedPath: `long-${bodyChars}.tour.md`,
        worktreePath: '/repo',
        taskName: 'Task',
      });
    };
    await reopen(TOUR_FILE_MAX_CHARS - UNDERSTANDING_MAX_OUTPUT_CHARS - 30_000);
    expect(tour.canAsk()).toBe(true);
    await reopen(TOUR_FILE_MAX_CHARS - UNDERSTANDING_MAX_OUTPUT_CHARS);
    expect(tour.canAsk()).toBe(false);
    expect(tour.askLimit()).toBe('size');
  });

  it('has nothing to open for an ungenerated subject or after a reset', async () => {
    const tour = await generatedPlanTour();
    expect(tour.open(FILE_INPUT)).toBe(false);
    expect(tour.isReady('file', 'src/pty.ts')).toBe(false);
    tour.reset();
    expect(tour.isReady('plan', 'output buffering')).toBe(false);
    expect(tour.open(PLAN_INPUT)).toBe(false);
  });

  it('announces a finished tour and a failed one through the hooks', async () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    const tour = setup({ onReady, onError });
    void tour.generate(PLAN_INPUT);
    await flush();
    stream(0, TOUR_JSON);
    await flush();
    expect(onReady).toHaveBeenCalledExactlyOnceWith('output buffering');
    expect(onError).not.toHaveBeenCalled();

    void tour.generate(FILE_INPUT);
    await flush();
    stream(1, 'not json');
    await flush();
    expect(onError).toHaveBeenCalledOnce();
    expect(String(onError.mock.calls[0][0])).not.toBe('');
  });

  it('reports no hook call for a cancelled generation', async () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    const tour = setup({ onReady, onError });
    void tour.generate(PLAN_INPUT);
    await flush();
    tour.cancel();
    stream(0, TOUR_JSON);
    await flush();
    expect(onReady).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('logs request timing with sizes only, never card text', async () => {
    vi.useFakeTimers();
    const tour = setup();
    void tour.generate(PLAN_INPUT);
    await flush();
    vi.advanceTimersByTime(1200);
    channels[0].onmessage?.({ type: 'chunk', text: TOUR_JSON });
    expect(tour.receiving()).toBe(true);
    vi.advanceTimersByTime(800);
    expect(tour.elapsedSeconds()).toBe(2);
    channels[0].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    expect(logInfo).toHaveBeenCalledExactlyOnceWith('understandingTour', 'Tour request finished', {
      requestId: expect.any(String),
      provider: 'minimax',
      request: 'tour',
      promptChars: expect.any(Number),
      responseChars: TOUR_JSON.length,
      firstOutputMs: 1200,
      durationMs: 2000,
      outcome: 'completed',
    });
    const context = vi.mocked(logInfo).mock.calls[0][2];
    expect(JSON.stringify(context)).not.toContain('Gist title');
    expect(JSON.stringify(context)).not.toContain('Body text.');
  });
});
