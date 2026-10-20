import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { InvestigationInspector } from './InvestigationInspector';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import type { Snapshot } from './state';
import { expectDefined } from '../store/test-helpers';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
let dispose: (() => void) | undefined;
let container: HTMLDivElement;
afterEach(() => {
  dispose?.();
  container.remove();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

interface Extras {
  onOpenSource?: (source: { label: string; path?: string; url?: string }) => Promise<void>;
  onCheckSource?: (source: {
    label: string;
    path?: string;
    url?: string;
  }) => Promise<boolean | undefined>;
  onRemoveExplanation?: (id: string) => void;
  onJumpToTranscript?: (recordId: string) => boolean;
  saving?: boolean;
  snapshot?: () => Snapshot;
}
function optionSnapshot(): Snapshot {
  return {
    version: 1,
    revision: 1,
    sequence: 0,
    caption: 'Compare options',
    relations: [
      { id: 'link', source: 'evidence', target: 'option', kind: 'supports', rationale: 'Fast' },
    ],
    explanations: [{ id: 'answer', nodeId: 'option', question: 'Why?', answer: 'Because.' }],
    records: [
      {
        id: 'option',
        kind: 'option',
        title: 'Queue ingestion',
        detail: 'Adds operations work',
        status: 'proposed',
        criteria: ['Latency below 100 ms'],
        sources: [
          { label: 'Benchmark', path: 'results/benchmark.json', line: 12 },
          { label: 'Dataset', url: 'https://example.org/dataset' },
        ],
      },
      {
        id: 'evidence',
        kind: 'observation',
        title: 'Benchmark run',
        detail: '',
        status: 'observed',
      },
    ],
  };
}
function mount(extras: Extras = {}) {
  const fixed = optionSnapshot();
  const snapshot = extras.snapshot ?? (() => fixed);
  container = document.createElement('div');
  document.body.append(container);
  dispose = render(
    () => (
      <InvestigationInspector
        snapshot={snapshot()}
        selected="option"
        onSelect={() => {}}
        onClose={() => {}}
        draft={
          extras.saving === undefined
            ? undefined
            : {
                title: 'Edited',
                detail: '',
                base: { title: 'Queue ingestion', detail: '' },
                question: '',
              }
        }
        onDraft={extras.saving === undefined ? undefined : () => {}}
        saving={extras.saving}
        onOpenSource={extras.onOpenSource}
        onCheckSource={extras.onCheckSource}
        onRemoveExplanation={extras.onRemoveExplanation}
        onJumpToTranscript={extras.onJumpToTranscript}
      />
    ),
    container,
  );
}
function click(text: string) {
  expectDefined(
    [...container.querySelectorAll('button')].find((b) => b.textContent === text),
  ).click();
}

it('shows option criteria and source destinations, copying files and opening URLs via IPC', async () => {
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  vi.mocked(invoke).mockResolvedValue(undefined);
  mount();
  expect(container.textContent).toContain('Option');
  expect(container.textContent).toContain('Latency below 100 ms');
  expect(container.textContent).not.toContain('confidence');
  expect(container.textContent).toContain('results/benchmark.json:12');
  expect(container.textContent).toContain('https://example.org/dataset');
  expect(container.querySelector('a')).toBeNull();
  expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Open')).toBe(
    false,
  );
  click('Copy location');
  await Promise.resolve();
  expect(copy).toHaveBeenCalledWith('results/benchmark.json:12');
  expect(invoke).not.toHaveBeenCalled();
  click('Open source');
  await Promise.resolve();
  expect(invoke).toHaveBeenCalledWith(IPC.ShellOpenExternal, {
    url: 'https://example.org/dataset',
  });
});

it('opens file sources in the app when the host offers it and still copies locations', async () => {
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  const onOpenSource = vi.fn(async () => {});
  mount({ onOpenSource });
  click('Open');
  await Promise.resolve();
  expect(onOpenSource).toHaveBeenCalledWith({
    label: 'Benchmark',
    path: 'results/benchmark.json',
    line: 12,
  });
  click('Copy location');
  await Promise.resolve();
  expect(copy).toHaveBeenCalledWith('results/benchmark.json:12');
  expect(invoke).not.toHaveBeenCalled();
});

it('names linked notes, lists saved answers with removal, and shows the saving state', () => {
  const onRemoveExplanation = vi.fn();
  mount({ onRemoveExplanation, saving: true });
  expect(container.textContent).toContain('Benchmark run → supports → Queue ingestion');
  expect(container.textContent).not.toContain('evidence → supports');
  const qa = expectDefined(container.querySelector('.investigation-qa'));
  expect(qa.textContent).toContain('Q&A · 1');
  expect(qa.textContent).toContain('Because.');
  expectDefined(qa.querySelector<HTMLButtonElement>('button')).click();
  expect(onRemoveExplanation).toHaveBeenCalledWith('answer');
  expect(document.activeElement).toBe(container.querySelector('.investigation-inspector'));
  const save = expectDefined(
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'Saving…'),
  );
  expect(save.disabled).toBe(true);
  expect(container.textContent).toContain('Use agent version');
});

it('surfaces a source opening failure', async () => {
  vi.mocked(invoke).mockRejectedValue(new Error('Browser unavailable'));
  mount();
  click('Open source');
  await Promise.resolve();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Browser unavailable');
});

function mountHypothesis(
  relations: Snapshot['relations'],
  sources?: { label: string; path: string }[],
) {
  const snapshot: Snapshot = {
    version: 1,
    revision: 1,
    sequence: 0,
    caption: 'Investigate',
    relations,
    records: [
      { id: 'goal', kind: 'goal', title: 'Fix duplicates', detail: '', status: 'unresolved' },
      {
        id: 'h1',
        kind: 'hypothesis',
        parent: 'goal',
        title: 'A retry repeats the write',
        detail: '',
        status: 'untested',
        confidence: 0.75,
        sources,
      },
      {
        id: 'obs',
        kind: 'observation',
        parent: 'h1',
        title: 'Two rows',
        detail: '',
        status: 'observed',
      },
      {
        id: 'exp',
        kind: 'experiment',
        parent: 'h1',
        title: 'Idempotency',
        detail: '',
        status: 'proposed',
      },
    ],
  };
  container = document.createElement('div');
  document.body.append(container);
  dispose = render(
    () => (
      <InvestigationInspector
        snapshot={snapshot}
        selected="h1"
        onSelect={() => {}}
        onClose={() => {}}
      />
    ),
    container,
  );
}

it('shows confidence beside its supporting, challenging and source counts', () => {
  mountHypothesis(
    [
      { id: 'l1', source: 'obs', target: 'h1', kind: 'supports', rationale: 'Same request id' },
      { id: 'l2', source: 'exp', target: 'h1', kind: 'challenges', rationale: 'Would refute' },
    ],
    [{ label: 'Repro', path: 'tests/orders.test.ts' }],
  );
  const line = expectDefined(container.querySelector('.investigation-confidence'));
  expect(line.textContent).toBe(
    "The agent's own estimate: 75% · 1 supporting · 1 challenging · 1 sources",
  );
  expect(line.classList.contains('investigation-confidence-bare')).toBe(false);
});

it('marks a confidence with no linked evidence as bare', () => {
  mountHypothesis([]);
  const line = expectDefined(container.querySelector('.investigation-confidence'));
  expect(line.textContent).toContain('0 supporting · 0 challenging · 0 sources');
  expect(line.classList.contains('investigation-confidence-bare')).toBe(true);
});

it('marks a task-relative source whose file is missing and leaves URLs alone', async () => {
  const onCheckSource = vi.fn(
    async (source: { path?: string }) => source.path !== undefined && false,
  );
  mount({ onCheckSource });
  await Promise.resolve();
  await Promise.resolve();
  expect(onCheckSource).toHaveBeenCalledTimes(1);
  expect(onCheckSource).toHaveBeenCalledWith({
    label: 'Benchmark',
    path: 'results/benchmark.json',
    line: 12,
  });
  expect(container.querySelectorAll('.investigation-source-missing')).toHaveLength(1);
  expect(container.textContent).toContain('Missing file');
});

it('checks sources once per selection rather than once per snapshot revision', async () => {
  const onCheckSource = vi.fn(async () => undefined);
  const [snapshot, setSnapshot] = createSignal(optionSnapshot());
  mount({ onCheckSource, snapshot });
  await Promise.resolve();
  expect(onCheckSource).toHaveBeenCalledTimes(1);
  setSnapshot({ ...optionSnapshot(), revision: 2 });
  await Promise.resolve();
  expect(onCheckSource).toHaveBeenCalledTimes(1);
});

it('shows no missing mark when the checker cannot tell', async () => {
  const onCheckSource = vi.fn(async () => undefined);
  mount({ onCheckSource });
  await Promise.resolve();
  await Promise.resolve();
  expect(container.textContent).not.toContain('Missing file');
});

it('jumps to the transcript for the selected note and explains when nothing is anchored', () => {
  const onJumpToTranscript = vi.fn(() => false);
  mount({ onJumpToTranscript });
  click('Jump to transcript');
  expect(onJumpToTranscript).toHaveBeenCalledWith('option');
  expect(container.textContent).toContain('No transcript position recorded for this node.');
  onJumpToTranscript.mockReturnValue(true);
  click('Jump to transcript');
  expect(container.textContent).not.toContain('No transcript position recorded');
});
