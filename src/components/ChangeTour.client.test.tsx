import { createSignal, createEffect, Show } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { parseUnifiedDiff } from '../lib/unified-diff-parser';
import { ChangeTour } from './ChangeTour';
import { ChangeTourButton } from './ChangeTourButton';
import { createChangeTour } from '../lib/create-change-tour';
import { info as logInfo } from '../lib/log';
import { setAskCodeModel, setAskCodeProvider, store } from '../store/store';
import {
  CHANGE_TOUR_TIMEOUT_MS,
  CHANGE_TOUR_PROMPT_LIMIT,
} from '../../electron/shared/change-tour-limits';

const channels = vi.hoisted(
  () =>
    [] as {
      onmessage: ((message: { type: string; text?: string; exitCode?: number }) => void) | null;
      dispose: () => void;
    }[],
);
vi.mock('../lib/ipc', () => ({
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
  const [store, setStore] = createStore({
    askCodeProvider: 'minimax',
    askCodeModel: 'sonnet',
    agentEnvFiles: {},
  });
  return {
    store,
    setAskCodeProvider: (provider: string) => setStore('askCodeProvider', provider),
    setAskCodeModel: (model: string) => setStore('askCodeModel', model),
  };
});
vi.mock('../lib/log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/log')>()),
  info: vi.fn(),
}));
const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
  channels.length = 0;
  vi.clearAllMocks();
  vi.useRealTimers();
  setAskCodeProvider('minimax');
  setAskCodeModel('sonnet');
});
const diff = 'diff --git a/file.ts b/file.ts\n@@ -1 +1 @@\n-old\n+new\n';

function mount(initialDiff = diff, initiallyDisabled = false) {
  const [raw, setRaw] = createSignal(initialDiff);
  const [disabled, setDisabled] = createSignal(initiallyDisabled);
  const [readerOpen, setReaderOpen] = createSignal(false);
  const navigate = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  disposers.push(
    render(() => {
      const tour = createChangeTour();
      createEffect(() => tour.reconcile(raw()));
      return (
        <>
          <ChangeTourButton
            tour={tour}
            disabled={disabled()}
            onClick={() => {
              if (tour.stops().length) setReaderOpen(true);
              else
                tour.generate({
                  rawDiff: raw(),
                  files: parseUnifiedDiff(raw()),
                  taskName: 'Task',
                  worktreePath: '/repo',
                });
            }}
          />
          <Show when={readerOpen()}>
            <ChangeTour
              tour={tour}
              worktreePath="/repo"
              onNavigate={navigate}
              onFinish={() => setReaderOpen(false)}
            />
          </Show>
        </>
      );
    }, host),
  );
  return { host, setRaw, navigate, setReaderOpen, setDisabled };
}
function complete(index = 0, filePath = 'file.ts', questions?: string[]) {
  const stop = {
    title: 'Changed behavior',
    explanation: 'The returned value changes.',
    locations: [{ filePath, line: 1 }],
    questions,
  };
  channels[index].onmessage?.({
    type: 'chunk',
    text: JSON.stringify({ stops: [stop, { ...stop, title: 'Tests' }] }),
  });
  channels[index].onmessage?.({ type: 'done', exitCode: 0 });
}

const progressText = (host: HTMLElement) =>
  host.querySelector('.understanding-progress')?.textContent ?? '';
function buttonByText(host: HTMLElement, text: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === text || candidate.getAttribute('aria-label') === text,
  );
  if (!button) throw new Error(`No button ${text}`);
  return button;
}
async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}
/** Generates the two-stop tour and opens the reader on its first stop. */
function openTour(questions?: string[]) {
  const mounted = mount();
  mounted.host.querySelector('button')?.click();
  complete(0, 'file.ts', questions);
  mounted.host.querySelector('button')?.click();
  return mounted;
}

const largeDiff = ['file.ts', 'second.ts', 'third.ts']
  .map(
    (filePath) =>
      `diff --git a/${filePath} b/${filePath}\n@@ -1 +1 @@\n-${'a'.repeat(CHANGE_TOUR_PROMPT_LIMIT / 3)}\n+${'b'.repeat(CHANGE_TOUR_PROMPT_LIMIT / 3)}\n`,
  )
  .join('');

describe('guided tour', () => {
  it('picks the tour model from the chevron beside Generate tour', () => {
    const { host } = mount();
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Tour model"]');
    const controls = host.querySelector('.change-tour-hover');
    if (!trigger || !controls) throw new Error('Missing model chevron');
    // The chevron is outside the hover anchor, so the help popover gives way to
    // the menu instead of standing over it.
    controls.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    trigger.click();
    // No backend answers the Codex model list here, so that group stays empty.
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('No Codex models found');
    const opus = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
      (item) => item.textContent?.trim() === 'opus',
    );
    opus?.click();
    expect(store.askCodeProvider).toBe('claude');
    expect(store.askCodeModel).toBe('opus');
  });

  it('explains generation and the configured model on hover/focus without generating', () => {
    const { host } = mount();
    const button = host.querySelector('button');
    const controls = button?.closest('.change-tour-hover');
    if (!button || !controls) throw new Error('Missing generate control');
    expect(button.textContent).toBe('Generate tour');
    // The action and the model chevron beside it, and nothing else.
    expect(host.querySelectorAll('button')).toHaveLength(2);
    controls.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('MiniMax-M3.1-Flash');
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
      'Sends the selected tour diff',
    );
    expect(invoke).not.toHaveBeenCalled();
    setAskCodeProvider('claude');
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
      'sonnet (CLI model alias)',
    );
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    button.focus();
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    button.click();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(channels).toHaveLength(1);
  });

  it('dismisses focused button help on outside click without generating', () => {
    const { host } = mount();
    host.querySelector('button')?.focus();
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
  it('accepts commentary after streamed tour JSON without starting another request', () => {
    const { host } = mount();
    host.querySelector('button')?.click();
    const response = JSON.stringify({
      stops: [
        {
          title: 'Behavior',
          explanation: 'Changes the value.',
          locations: [{ filePath: 'file.ts', line: 1 }],
        },
      ],
    });
    channels[0].onmessage?.({ type: 'chunk', text: response });
    channels[0].onmessage?.({ type: 'chunk', text: '\nNote: tests were not executed.' });
    channels[0].onmessage?.({ type: 'done', exitCode: 0 });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('button')?.textContent).toContain('Start tour');
    expect(channels).toHaveLength(1);
  });
  it('logs request timing once without logging code or response content', () => {
    vi.useFakeTimers();
    const { host, setRaw } = mount();
    host.querySelector('button')?.click();
    vi.advanceTimersByTime(1200);
    channels[0].onmessage?.({ type: 'chunk', text: ' ' });
    vi.advanceTimersByTime(800);
    complete();
    setRaw(diff.replace('+new', '+newer'));
    expect(logInfo).toHaveBeenCalledExactlyOnceWith('changeTour', 'Tour request finished', {
      requestId: expect.any(String),
      provider: 'minimax',
      part: 1,
      parts: 1,
      promptChars: expect.any(Number),
      responseChars: expect.any(Number),
      firstOutputMs: 1200,
      durationMs: 2000,
      outcome: 'completed',
    });
  });
  it('hides the entire footer until changed files are available', () => {
    const { host, setDisabled } = mount(diff, true);
    expect(host.textContent).toBe('');
    expect(host.querySelector('button')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    setDisabled(false);
    expect(host.querySelector('button')?.textContent).toBe('Generate tour');
    setDisabled(true);
    expect(host.querySelector('button')).toBeNull();
  });

  it('keeps active and ready tours accessible if the live file list becomes empty', () => {
    const { host, setDisabled } = mount();
    host.querySelector('button')?.click();
    setDisabled(true);
    expect(host.querySelector('button[aria-busy="true"] .inline-spinner')).not.toBeNull();
    complete();
    expect(host.querySelector('button')?.textContent).toContain('Start tour');
    expect(host.querySelector('button')?.disabled).toBe(false);
  });

  it('shows a ready checkmark and opens the completed tour without regenerating it', () => {
    const { host, navigate } = mount();
    host.querySelector('button')?.click();
    expect(host.querySelector('[aria-label="Guided change tour"]')).toBeNull();
    complete();
    expect(host.querySelector('[aria-label="Tour ready"]')).not.toBeNull();
    expect(host.querySelector('button')?.textContent).toContain('Start tour');
    expect(navigate).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-label="Guided change tour"]')).toBeNull();
    host.querySelector('button')?.click();
    expect(host.querySelector('[aria-label="Guided change tour"]')).not.toBeNull();
    expect(
      vi.mocked(invoke).mock.calls.filter(([channel]) => channel === IPC.AskAboutCode),
    ).toHaveLength(1);
  });
  it('shows a spinner, elapsed time and incoming response activity while generating', () => {
    vi.useFakeTimers();
    const { host } = mount();
    host.querySelector('button')?.click();
    expect(host.querySelector('.inline-spinner')).not.toBeNull();
    expect(host.querySelector('button')?.getAttribute('aria-busy')).toBe('true');
    vi.advanceTimersByTime(5000);
    expect(host.textContent).toContain('Waiting for provider · 5s');
    channels[0].onmessage?.({ type: 'chunk', text: '{' });
    expect(host.textContent).toContain('Receiving response · 5s');
    channels[0].onmessage?.({ type: 'error', text: 'Provider disconnected' });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Provider disconnected');
  });

  it('times out when IPC never completes and ignores late results', () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockImplementationOnce(() => new Promise(() => {}));
    const { host, navigate } = mount(largeDiff);
    host.querySelector('button')?.click();
    vi.advanceTimersByTime(CHANGE_TOUR_TIMEOUT_MS + 5000);
    expect(logInfo).toHaveBeenCalledWith(
      'changeTour',
      'Tour request finished',
      expect.objectContaining({
        outcome: 'timeout',
        firstOutputMs: null,
        durationMs: CHANGE_TOUR_TIMEOUT_MS + 5000,
      }),
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'did not finish within five minutes',
    );
    expect(host.querySelector('.inline-spinner')).toBeNull();
    expect(host.querySelector('button')?.getAttribute('aria-busy')).toBe('false');
    expect(invoke).toHaveBeenCalledWith(
      IPC.CancelAskAboutCode,
      expect.objectContaining({ requestId: expect.any(String) }),
    );
    complete();
    expect(navigate).not.toHaveBeenCalled();
    expect(channels).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up each part’s timers and cancels them when the diff changes', () => {
    vi.useFakeTimers();
    const { host, setRaw } = mount(largeDiff);
    host.querySelector('button')?.click();
    expect(vi.getTimerCount()).toBe(2);
    complete();
    expect(channels).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(2);
    setRaw(diff);
    expect(vi.getTimerCount()).toBe(0);
    expect(host.querySelector('.inline-spinner')).toBeNull();
  });

  it('generates on request and navigates stops', () => {
    const { host, navigate } = mount();
    expect(invoke).not.toHaveBeenCalled();
    host.querySelector('button')?.click();
    expect(invoke).toHaveBeenCalledWith(
      IPC.AskAboutCode,
      expect.objectContaining({ provider: 'minimax', purpose: 'tour' }),
    );
    complete();
    host.querySelector('button')?.click();
    expect(progressText(host)).toContain('1 / 2');
    expect(navigate).toHaveBeenCalledWith({ filePath: 'file.ts', line: 1 });
    const content = host.querySelector<HTMLElement>('.change-tour-stage');
    if (!content) throw new Error('Tour content is missing');
    content.scrollTop = 120;
    buttonByText(host, 'Next').click();
    expect(progressText(host)).toContain('2 / 2');
    expect(host.querySelector('h2')?.textContent).toBe('Tests');
    expect(content.scrollTop).toBe(0);
  });

  it('cancels and ignores a stale response when the diff changes', () => {
    const { host, setRaw, navigate } = mount();
    host.querySelector('button')?.click();
    setRaw(diff.replace('+new', '+newer'));
    expect(invoke).toHaveBeenCalledWith(
      IPC.CancelAskAboutCode,
      expect.objectContaining({ requestId: expect.any(String) }),
    );
    complete();
    expect(navigate).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('Changed behavior');
  });

  it('shows provider failures without treating a partial explanation as a tour', () => {
    const { host } = mount();
    host.querySelector('button')?.click();
    channels[0].onmessage?.({ type: 'error', text: 'Provider unavailable' });
    channels[0].onmessage?.({ type: 'done', exitCode: 1 });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Provider unavailable');
  });

  // The Claude CLI prints API errors and usage limits to stdout in text mode.
  it('shows what the provider printed when it fails without stderr', () => {
    const { host } = mount();
    host.querySelector('button')?.click();
    channels[0].onmessage?.({ type: 'chunk', text: 'Invalid API key\n' });
    channels[0].onmessage?.({ type: 'done', exitCode: 1 });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Invalid API key');
  });

  it('processes a large diff sequentially and combines all parts into one tour', () => {
    const { host, navigate } = mount(largeDiff);
    host.querySelector('button')?.click();
    expect(host.querySelector('button')?.textContent).toContain('part 1 of 3');
    expect(channels).toHaveLength(1);
    complete();
    expect(channels).toHaveLength(2);
    expect(host.querySelector('button')?.textContent).toContain('part 2 of 3');
    expect(navigate).not.toHaveBeenCalled();
    complete(1, 'second.ts');
    complete(2, 'third.ts');
    expect(navigate).not.toHaveBeenCalled();
    host.querySelector('button')?.click();
    expect(progressText(host)).toContain('1 / 6');
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(navigate).toHaveBeenCalledWith({ filePath: 'file.ts', line: 1 });
    for (const [channel, args] of vi.mocked(invoke).mock.calls) {
      if (channel === IPC.AskAboutCode)
        expect((args?.prompt as string).length).toBeLessThanOrEqual(CHANGE_TOUR_PROMPT_LIMIT);
    }
  });

  it('cancels the active part and never starts remaining parts', () => {
    const { host, navigate } = mount(largeDiff);
    host.querySelector('button')?.click();
    complete();
    [...host.querySelectorAll('button')]
      .find((button) => button.title === 'Cancel tour generation')
      ?.click();
    complete(1, 'second.ts');
    expect(channels).toHaveLength(2);
    expect(navigate).not.toHaveBeenCalled();
    const calls = vi.mocked(invoke).mock.calls;
    const activeRequest = calls.filter(([channel]) => channel === IPC.AskAboutCode)[1][1];
    expect(invoke).toHaveBeenCalledWith(IPC.CancelAskAboutCode, {
      requestId: activeRequest?.requestId,
    });
  });

  it('does not present a partial tour as complete if a later part fails', () => {
    const { host, navigate } = mount(largeDiff);
    host.querySelector('button')?.click();
    complete();
    channels[1].onmessage?.({ type: 'error', text: 'Provider unavailable' });
    channels[1].onmessage?.({ type: 'done', exitCode: 1 });
    expect(channels).toHaveLength(2);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Provider unavailable');
    expect(host.textContent).not.toContain('Stop 1');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('draws each stop as a tour card with its label and tone', () => {
    const { host } = mount();
    host.querySelector('button')?.click();
    const stop = {
      label: 'entry point',
      title: 'Risky change',
      explanation: 'Callers break.',
      tone: 'risk',
      whyItMatters: 'Existing data is rewritten.',
      locations: [{ filePath: 'file.ts', line: 1 }],
    };
    channels[0].onmessage?.({ type: 'chunk', text: JSON.stringify({ stops: [stop] }) });
    channels[0].onmessage?.({ type: 'done', exitCode: 0 });
    host.querySelector('button')?.click();
    const card = host.querySelector('.understanding-card');
    expect(card?.getAttribute('data-tone')).toBe('risk');
    expect(card?.textContent).toContain('⚠ ENTRY POINT');
    expect(card?.textContent).toContain('Existing data is rewritten.');
    expect(card?.querySelector('.understanding-ref')?.textContent).toBe('file.ts:1');
  });

  it('jumps stops from the progress strip and with arrow keys while the tour has focus', () => {
    const { host, navigate } = openTour();
    buttonByText(host, 'Card 2 of 2: Tests').click();
    expect(progressText(host)).toContain('2 / 2');
    const previous = buttonByText(host, 'Previous');
    previous.focus();
    previous.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(progressText(host)).toContain('1 / 2');
    // Outside the tour the keys belong to the diff.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(progressText(host)).toContain('1 / 2');
    expect(navigate).toHaveBeenLastCalledWith({ filePath: 'file.ts', line: 1 });
  });

  it('opens with the gist, closes with what to verify and highlights a stop range', () => {
    const { host, navigate } = mount();
    host.querySelector('button')?.click();
    const stop = {
      title: 'Returns the new value',
      explanation: 'The returned value changes.',
      locations: [{ filePath: 'file.ts', line: 1, endLine: 2 }],
    };
    channels[0].onmessage?.({
      type: 'chunk',
      text: JSON.stringify({
        gist: { title: 'The file now returns new', explanation: 'It returned old.' },
        stops: [stop],
        verify: { title: 'Check callers expect new', explanation: 'Callers compare it.' },
      }),
    });
    channels[0].onmessage?.({ type: 'done', exitCode: 0 });
    host.querySelector('button')?.click();
    expect(progressText(host)).toContain('1 / 3');
    expect(host.querySelector('.understanding-card')?.textContent).toContain('THE GIST');
    // The gist is about the whole change, so it points nowhere in the diff.
    expect(navigate).not.toHaveBeenCalled();
    buttonByText(host, 'Next').click();
    expect(navigate).toHaveBeenLastCalledWith({ filePath: 'file.ts', line: 1, endLine: 2 });
    expect(host.querySelector('.understanding-ref')?.textContent).toBe('file.ts:1-2');
    buttonByText(host, 'Next').click();
    expect(host.querySelector('.understanding-card')?.textContent).toContain('BEFORE MERGING');
  });

  it('lists every card title in the overview and opens the one picked', () => {
    const { host } = openTour();
    buttonByText(host, 'Show overview').click();
    const items = [...host.querySelectorAll('.understanding-overview li')];
    expect(items.map((item) => item.textContent)).toEqual([
      'STOP 1Changed behavior',
      'STOP 2Tests',
    ]);
    expect(host.querySelector('.understanding-overview [aria-current="step"]')?.textContent).toBe(
      'STOP 1Changed behavior',
    );
    items[1].querySelector('button')?.click();
    expect(host.querySelector('.understanding-overview')).toBeNull();
    expect(progressText(host)).toContain('2 / 2');
  });

  it('offers to resume a tour the reader left midway', () => {
    const { host, setReaderOpen } = openTour();
    buttonByText(host, 'Next').click();
    setReaderOpen(false);
    expect(host.querySelector('button')?.textContent).toContain('Resume tour · 2/2');
  });

  it('asks about a stop with the diff as context and keeps the answer under it', async () => {
    const { host } = openTour();
    const input = host.querySelector<HTMLInputElement>('.understanding-ask-input');
    if (!input) throw new Error('Ask input is missing');
    input.value = 'Why this value?';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(host.querySelector('.understanding-thread[aria-busy="true"]')?.textContent).toContain(
      'Why this value?',
    );
    const asks = vi.mocked(invoke).mock.calls.filter(([channel]) => channel === IPC.AskAboutCode);
    expect(asks[1][1]?.purpose).toBe('understand');
    const prompt = String(asks[1][1]?.prompt);
    expect(prompt).toContain('the code change');
    expect(prompt).toContain('the diff the tour was built from');
    expect(prompt).toContain('+new');
    const answer = {
      cards: [{ label: 'ANSWER', title: 'Because', body: 'Reasons.', tone: 'neutral' }],
    };
    channels[1].onmessage?.({ type: 'chunk', text: JSON.stringify(answer) });
    channels[1].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    expect(host.querySelector('.understanding-thread')?.textContent).toContain('Because');
    expect(
      host.querySelector('.understanding-segments > button')?.hasAttribute('data-answered'),
    ).toBe(true);
    // The answer stays with its stop.
    buttonByText(host, 'Next').click();
    expect(host.querySelector('.understanding-thread')).toBeNull();
  });

  it('lets readers retry a cancelled suggestion and hides it after an answer', async () => {
    const question = 'Which callers depend on the old return value?';
    const { host } = openTour([question]);
    const suggestion = () => host.querySelector<HTMLButtonElement>('.tour-question');
    expect(suggestion()?.textContent).toContain(question);
    suggestion()?.click();
    await flush();
    expect(suggestion()?.disabled).toBe(true);
    buttonByText(host, 'Cancel question').click();
    expect(suggestion()?.disabled).toBe(false);
    suggestion()?.click();
    await flush();
    const asks = vi.mocked(invoke).mock.calls.filter(([channel]) => channel === IPC.AskAboutCode);
    expect(asks).toHaveLength(3);
    expect(String(asks[2][1]?.prompt)).toContain(JSON.stringify(question));
    channels[2].onmessage?.({
      type: 'chunk',
      text: JSON.stringify({
        cards: [{ label: 'ANSWER', title: 'Callers', body: 'Check callers.' }],
      }),
    });
    channels[2].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    expect(suggestion()).toBeNull();
    expect(host.querySelector('.understanding-thread')?.getAttribute('aria-label')).toBe(question);
    buttonByText(host, 'Next').click();
    expect(suggestion()?.disabled).toBe(false);
    expect(host.querySelector('.understanding-thread')).toBeNull();
  });

  it('reworks the tour from the same diff with the reader request', () => {
    const { host } = openTour();
    buttonByText(host, 'Rework tour').click();
    const input = host.querySelector<HTMLInputElement>('.tour-rework input');
    if (!input) throw new Error('Rework input is missing');
    input.value = 'Tests first';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(host.querySelector('.change-tour')?.textContent).toContain('Reworking tour…');
    const asks = vi.mocked(invoke).mock.calls.filter(([channel]) => channel === IPC.AskAboutCode);
    expect(String(asks[1][1]?.prompt)).toContain('"Tests first"');
    expect(String(asks[1][1]?.prompt)).toContain('+new');
    complete(1);
    expect(progressText(host)).toContain('1 / 2');
  });
});
