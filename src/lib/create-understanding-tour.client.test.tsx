import { createRoot } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { UNDERSTANDING_TIMEOUT_MS } from '../../electron/shared/understanding-limits';
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

  it('asks a follow-up and keeps the answer under the current card', async () => {
    const tour = await generatedPlanTour();
    tour.navigate(1);
    void tour.ask('Why buffer first?');
    await flush();
    expect(tour.asking()).toBe(true);
    expect(tour.pendingQuestion()).toBe('Why buffer first?');
    expect(channels).toHaveLength(2);
    expect(promptOf(1)).toContain('Why buffer first?');
    expect(promptOf(1)).toContain('Buffer before IPC.');
    stream(1, BRANCH_JSON);
    await flush();
    expect(tour.asking()).toBe(false);
    expect(tour.pendingQuestion()).toBe('');
    expect(tour.step()).toBe(1);
    expect(tour.threadsFor(1)).toHaveLength(1);
    expect(tour.threadsFor(1)[0].question).toBe('Why buffer first?');
    expect(tour.threadsFor(1)[0].cards).toHaveLength(2);
    expect(tour.threadsFor(0)).toHaveLength(0);
    // Moving on and back does not lose the thread.
    tour.next();
    tour.previous();
    expect(tour.threadsFor(1)).toHaveLength(1);
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
    expect(tour.threadsFor(1)).toHaveLength(1);
    expect(tour.threadsFor(2)).toHaveLength(0);
  });

  it('clears provider stderr once the branch parses', async () => {
    const tour = await generatedPlanTour();
    void tour.ask('Why buffer first?');
    await flush();
    channels[1].onmessage?.({ type: 'error', text: 'provider warning on stderr' });
    expect(tour.error()).toBe('provider warning on stderr');
    stream(1, BRANCH_JSON);
    await flush();
    expect(tour.threads()[0]?.cards).toHaveLength(2);
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
    expect(tour.threads()).toHaveLength(0);
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
    expect(tour.threads()).toHaveLength(0);
  });

  it('keeps the threads of a cached tour when it is reopened', async () => {
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
    expect(tour.threads()).toHaveLength(0);

    expect(tour.open(PLAN_INPUT)).toBe(true);
    expect(tour.threadsFor(2)).toHaveLength(1);
    expect(tour.threadsFor(2)[0].question).toBe('What breaks?');
  });

  it('adds a second answer under the same card and replays the first', async () => {
    const tour = await generatedPlanTour();
    tour.navigate(1);
    void tour.ask('First?');
    await flush();
    stream(1, BRANCH_JSON);
    await flush();
    void tour.ask('Second?');
    await flush();
    expect(promptOf(2)).toContain('already answered');
    expect(promptOf(2)).toContain('Deep one');
    stream(2, JSON.stringify({ cards: [card({ title: 'Follow-on' })] }));
    await flush();
    const threads = tour.threadsFor(1);
    expect(threads.map((thread) => thread.question)).toEqual(['First?', 'Second?']);
    expect(threads[1].cards).toHaveLength(1);
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
    expect(tour.threads()).toHaveLength(0);
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
    expect(tour.threads()).toHaveLength(1);

    tour.rework('Explain it for a newcomer');
    await flush();
    expect(tour.progress()).toBe('Reworking tour…');
    expect(promptOf(2)).toContain('"Explain it for a newcomer"');
    expect(promptOf(2)).toContain('Buffer before IPC.');
    stream(2, JSON.stringify({ gist: card({ title: 'Simpler gist' }), cards: [card()] }));
    await flush();
    expect(tour.tour()?.cards[0]?.title).toBe('Simpler gist');
    expect(tour.threads()).toHaveLength(0);
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
    expect(tour.threadsFor(0)).toHaveLength(1);

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
