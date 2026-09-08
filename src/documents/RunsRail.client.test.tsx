import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import type { DocumentRunRecord } from './types';
import { RunsRail } from './RunsRail';
import { closeDocumentCompare, openDocumentCompare, rejectDocumentRun } from './store';
import { openCandidateOutput } from './workspace-ui';

const { state } = vi.hoisted(() => ({
  state: { runs: {} as Record<string, DocumentRunRecord>, runOrder: ['run-1'], logs: {} },
}));
vi.mock('./store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store')>()),
  documentStore: state,
  openDocumentCompare: vi.fn(),
  rejectDocumentRun: vi.fn(async () => {}),
}));
vi.mock('./workspace-ui', () => ({ openCandidateOutput: vi.fn() }));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function mount(status: DocumentRunRecord['status'] = 'finished', hasProposal = true) {
  state.runs = {
    'run-1': {
      version: 1,
      id: 'run-1',
      documentPath: 'doc.md',
      createdAt: new Date(0).toISOString(),
      instruction: 'Improve the introduction',
      baseSha: 'abc123',
      scope: { path: 'doc.md', wholeDocument: true, startLine: 1, endLine: 1, quote: '' },
      status,
      candidates: [
        {
          id: 'c2',
          label: 'B',
          agentId: 'codex',
          agentName: 'Codex',
          isMain: false,
          status: hasProposal ? 'done' : 'failed',
          commitSha: hasProposal ? 'proposal-sha' : null,
          branch: 'proposal',
          worktreePath: '/tmp/proposal',
          startedAt: new Date(0).toISOString(),
        },
      ],
    },
  };
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <RunsRail />, host);
  return host;
}

it('opens the clicked completed proposal and keeps output as a separate action', () => {
  const host = mount();
  host.querySelector<HTMLButtonElement>('[aria-label="Review proposal B"]')?.click();
  expect(openDocumentCompare).toHaveBeenCalledWith('run-1', 'c2');
  expect(openCandidateOutput).not.toHaveBeenCalled();
  host.querySelector<HTMLButtonElement>('[aria-label="View output for proposal B"]')?.click();
  expect(openCandidateOutput).toHaveBeenCalledWith({ runId: 'run-1', candidateId: 'c2' });
  expect(openDocumentCompare).toHaveBeenCalledTimes(1);
});

it.each(['running', 'accepted', 'rejected'] as const)('opens output for a %s run', (status) => {
  const host = mount(status);
  host.querySelector<HTMLButtonElement>('.docws-candidate-main')?.click();
  expect(openCandidateOutput).toHaveBeenCalledWith({ runId: 'run-1', candidateId: 'c2' });
  expect(openDocumentCompare).not.toHaveBeenCalled();
});

it('opens output when a candidate has no proposal', () => {
  const host = mount('finished', false);
  host.querySelector<HTMLButtonElement>('.docws-candidate-main')?.click();
  expect(openCandidateOutput).toHaveBeenCalledWith({ runId: 'run-1', candidateId: 'c2' });
  expect(openDocumentCompare).not.toHaveBeenCalled();
});

function textButton(root: ParentNode, label: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function dialog(): Element {
  const found = document.querySelector('[role="dialog"]');
  if (!found) throw new Error('No dialog is open');
  return found;
}

it('asks before throwing a proposal away, and rejects only once confirmed', async () => {
  const host = mount();
  textButton(host, 'Reject all').click();

  expect(dialog().textContent).toContain('Reject this proposal?');
  textButton(dialog(), 'Cancel').click();
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(rejectDocumentRun).not.toHaveBeenCalled();

  textButton(host, 'Reject all').click();
  textButton(dialog(), 'Reject').click();
  await vi.waitFor(() => expect(rejectDocumentRun).toHaveBeenCalledWith('run-1'));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('dismisses a run that produced no proposal without asking', () => {
  const host = mount('finished', false);
  textButton(host, 'Dismiss').click();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(rejectDocumentRun).toHaveBeenCalledWith('run-1');
});

it('clears a selected candidate when opening a different run or closing comparison', async () => {
  const actual = await vi.importActual<typeof import('./store')>('./store');
  actual.openDocumentCompare('run-1', 'c2');
  expect(actual.documentStore.compareCandidateId).toBe('c2');
  actual.openDocumentCompare('run-2');
  expect(actual.documentStore.compareCandidateId).toBeNull();
  actual.openDocumentCompare('run-1', 'c2');
  closeDocumentCompare();
  expect(actual.documentStore.compareCandidateId).toBeNull();
});
