import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CandidateRefinement } from './CandidateRefinement';
import { refineDocumentCandidate } from './store';
import type { DocumentRunRecord } from './types';

vi.mock('./store', () => ({ refineDocumentCandidate: vi.fn() }));
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.resetAllMocks();
});

const run: DocumentRunRecord = {
  version: 1,
  id: 'run-1',
  documentPath: 'plan.md',
  createdAt: '',
  instruction: 'Plan',
  scope: { path: 'plan.md', wholeDocument: true, startLine: 1, endLine: 1, quote: '' },
  baseSha: 'abcdef123',
  status: 'finished',
  candidates: [
    {
      id: 'c1',
      label: 'A',
      agentId: 'codex',
      agentName: 'Codex',
      isMain: false,
      branch: 'parallel-doc/test-a',
      worktreePath: '/tmp/test',
      status: 'done',
      commitSha: 'abcdef456',
      startedAt: '',
    },
  ],
};

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <CandidateRefinement run={run} candidate={run.candidates[0]} />, host);
  host.querySelector('button')?.click();
  return host;
}

describe('CandidateRefinement', () => {
  it('requires feedback, starts a revision, and closes after success', async () => {
    vi.mocked(refineDocumentCandidate).mockResolvedValue();
    const host = mount();
    const submit = host.querySelector('.docws-btn-primary') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const input = host.querySelector('textarea') as HTMLTextAreaElement;
    input.value = '  Explain the tradeoff  ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    submit.click();
    expect(submit.disabled).toBe(true);
    await vi.waitFor(() => expect(host.querySelector('textarea')).toBeNull());
    expect(refineDocumentCandidate).toHaveBeenCalledWith(
      run,
      run.candidates[0],
      'Explain the tradeoff',
    );
  });

  it('keeps feedback available when dispatch fails', async () => {
    vi.mocked(refineDocumentCandidate).mockRejectedValue(new Error('Agent is unavailable'));
    const host = mount();
    const input = host.querySelector('textarea') as HTMLTextAreaElement;
    input.value = 'Keep this feedback';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (host.querySelector('.docws-btn-primary') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(host.querySelector('[role="alert"]')?.textContent).toBe('Agent is unavailable'),
    );
    expect(input.value).toBe('Keep this feedback');
    expect(host.querySelector<HTMLButtonElement>('.docws-btn-primary')?.disabled).toBe(false);
  });
});
