import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { AttentionLine } from './AttentionLine';

const { state, openDocumentCompare, setRailTab } = vi.hoisted(() => ({
  state: { runs: [] as unknown[], asking: false },
  openDocumentCompare: vi.fn(),
  setRailTab: vi.fn(),
}));

vi.mock('./store', () => ({
  reviewableRuns: () => state.runs,
  openDocumentCompare,
  activeDocumentPath: () => 'doc.md',
}));
vi.mock('./agent-task', () => ({ isDocumentAgentWaiting: () => state.asking }));
vi.mock('./workspace-ui', () => ({ setRailTab }));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  state.runs = [];
  state.asking = false;
  vi.clearAllMocks();
});

function run(id: string, proposals: number, documentPath = 'doc.md'): unknown {
  return {
    id,
    documentPath,
    candidates: Array.from({ length: proposals }, (_, i) => ({ id: `c${i}`, commitSha: 'sha' })),
  };
}

function mount(): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <AttentionLine projectId="docs" />, host);
  return host;
}

function button(host: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) ?? null
  );
}

it('renders nothing while nothing waits for the reader', () => {
  expect(mount().textContent).toBe('');
});

it('names the proposals ready and opens the first run for review', () => {
  state.runs = [run('run-1', 1), run('run-2', 1)];
  const host = mount();

  expect(host.textContent).toContain('2 proposals ready');
  button(host, 'Review')?.click();

  expect(openDocumentCompare).toHaveBeenCalledWith('run-1');
});

it('says so when the agent is asking a question and brings its tab up', () => {
  state.asking = true;
  const host = mount();

  expect(host.textContent).toContain('Agent is asking a question');
  expect(button(host, 'Review')).toBeNull();
  button(host, 'Show')?.click();

  expect(setRailTab).toHaveBeenCalledWith('agent');
});

it('counts and opens only the runs of the document on screen', () => {
  state.runs = [run('other', 3, 'other.md'), run('run-1', 1)];
  const host = mount();

  expect(host.textContent).toContain('1 proposal ready');
  button(host, 'Review')?.click();

  expect(openDocumentCompare).toHaveBeenCalledWith('run-1');
});

it('stays quiet when only other documents have proposals', () => {
  state.runs = [run('other', 1, 'other.md')];
  expect(mount().textContent).toBe('');
});
