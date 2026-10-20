import { Show } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import { IPC } from '../../electron/ipc/channels';
import { InlineReview } from './InlineReview';
import {
  acceptDocumentCandidate,
  closeDocumentReview,
  closeDocumentWorkspace,
  documentStore,
  inlineReview,
  openDocumentCompare,
  openDocumentFile,
  openDocumentWorkspace,
  rejectDocumentRun,
} from './store';
import type { DocumentCandidateRecord, DocumentRunRecord } from './types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../lib/ipc', () => ({
  invoke,
  Channel: class {
    dispose() {}
  },
}));
vi.mock('./store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store')>()),
  acceptDocumentCandidate: vi.fn(async () => {}),
  rejectDocumentRun: vi.fn(async () => {}),
}));

const BASE = '# Doc\n\nOriginal intro.\n\nTail.\n';
const PROPOSAL = '# Doc\n\nBetter intro.\n\nTail.\n';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  closeDocumentWorkspace();
  setStore({ projects: [], documentWorkspacesEnabled: false });
  vi.clearAllMocks();
});

function candidate(id: string): DocumentCandidateRecord {
  return {
    id,
    label: id.toUpperCase(),
    agentId: 'codex',
    agentName: 'Codex',
    isMain: false,
    status: 'done',
    commitSha: `sha-${id}`,
    branch: `branch-${id}`,
    worktreePath: `/tmp/${id}`,
    startedAt: new Date(0).toISOString(),
    rationale: {
      summary: 'Sharper intro',
      changes: [],
      assumptions: [],
      questions: [],
      warnings: [],
    },
  };
}

function run(candidates: DocumentCandidateRecord[]): DocumentRunRecord {
  return {
    version: 1,
    id: 'run-1',
    documentPath: 'notes.md',
    createdAt: new Date(0).toISOString(),
    instruction: 'Improve the introduction',
    baseSha: 'base-sha',
    scope: { path: 'notes.md', wholeDocument: true, startLine: 1, endLine: 1, quote: '' },
    status: 'finished',
    candidates,
  };
}

async function openWith(
  candidates: DocumentCandidateRecord[],
  snapshot: { headSha: string; dirty: boolean } = { headSha: 'base-sha', dirty: false },
  read: (sha: string) => string | null | Promise<string | null> = (sha) =>
    sha === 'base-sha' ? BASE : PROPOSAL,
): Promise<HTMLElement> {
  invoke.mockImplementation(async (channel: string, args: unknown) => {
    if (channel === IPC.ReadDocument)
      return { content: BASE, branch: 'main', missing: false, ...snapshot };
    if (channel === IPC.ListDocumentRuns) return [run(candidates)];
    if (channel === IPC.GetDocumentAtCommit) return read((args as { sha: string }).sha);
    return [];
  });
  setStore({
    documentWorkspacesEnabled: true,
    projects: [
      {
        id: 'docs',
        name: 'Notes',
        path: '/projects/notes',
        color: '',
        kind: 'document',
        documentPath: 'notes.md',
      },
    ],
  });
  await openDocumentWorkspace('docs');
  await vi.waitFor(() => expect(documentStore.runOrder).toEqual(['run-1']));
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(
    () => (
      <Show when={inlineReview()}>
        {(review) => <InlineReview run={review().run} candidate={review().candidate} />}
      </Show>
    ),
    host,
  );
  return host;
}

function button(root: ParentNode, label: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

it('reviews a single proposal inline as tracked changes, without the modal', async () => {
  const host = await openWith([candidate('a')]);
  openDocumentCompare('run-1');
  await vi.waitFor(() => expect(host.querySelector('.is-added, .is-changed')).not.toBeNull());

  expect(documentStore.compareRunId).toBeNull();
  expect(host.textContent).toContain('Sharper intro');
  expect(host.querySelector('.is-removed')?.textContent).toContain('Original intro.');
  expect(host.textContent).toContain('Better intro.');
});

it('accepts through the same store operation as the compare view', async () => {
  const host = await openWith([candidate('a')]);
  openDocumentCompare('run-1');
  await vi.waitFor(() => expect(button(host, 'Accept').disabled).toBe(false));
  button(host, 'Accept').click();
  expect(acceptDocumentCandidate).toHaveBeenCalledWith('run-1', 'a');
});

it('rejects the run after confirmation', async () => {
  const host = await openWith([candidate('a')]);
  openDocumentCompare('run-1');
  await vi.waitFor(() => button(host, 'Reject'));
  button(host, 'Reject').click();
  button(document.body.querySelector('[role="dialog"]') ?? document.body, 'Reject').click();
  await vi.waitFor(() => expect(rejectDocumentRun).toHaveBeenCalledWith('run-1'));
});

it('opens the compare view from Open side by side', async () => {
  const host = await openWith([candidate('a')]);
  openDocumentCompare('run-1');
  await vi.waitFor(() => button(host, 'Open side by side'));
  button(host, 'Open side by side').click();
  expect(documentStore.compareRunId).toBe('run-1');
  expect(documentStore.reviewRunId).toBeNull();
  expect(host.querySelector('.docws-inline-review')).toBeNull();
});

it('keeps the modal for two or more proposals', async () => {
  const host = await openWith([candidate('a'), candidate('b')]);
  openDocumentCompare('run-1');
  expect(documentStore.compareRunId).toBe('run-1');
  expect(documentStore.reviewRunId).toBeNull();
  expect(host.querySelector('.docws-inline-review')).toBeNull();
});

it('leaves the inline review on Escape without deciding', async () => {
  const host = await openWith([candidate('a')]);
  openDocumentCompare('run-1');
  await vi.waitFor(() => expect(host.querySelector('.docws-inline-review')).not.toBeNull());

  expect(closeDocumentReview()).toBe(true);
  expect(host.querySelector('.docws-inline-review')).toBeNull();
  expect(closeDocumentReview()).toBe(false);
  expect(acceptDocumentCandidate).not.toHaveBeenCalled();
  expect(rejectDocumentRun).not.toHaveBeenCalled();
});

it('uses the modal when the document moved on since the run base', async () => {
  const host = await openWith([candidate('a')], { headSha: 'newer-sha', dirty: false });
  openDocumentCompare('run-1');
  expect(documentStore.compareRunId).toBe('run-1');
  expect(documentStore.reviewRunId).toBeNull();
  expect(host.querySelector('.docws-inline-review')).toBeNull();
});

it('uses the modal while the document has uncommitted edits', async () => {
  await openWith([candidate('a')], { headSha: 'base-sha', dirty: true });
  openDocumentCompare('run-1');
  expect(documentStore.compareRunId).toBe('run-1');
  expect(documentStore.reviewRunId).toBeNull();
});

it('leaves the inline review when another document is shown', async () => {
  await openWith([candidate('a')]);
  openDocumentCompare('run-1');
  expect(documentStore.reviewRunId).toBe('run-1');
  await openDocumentFile('other.md');
  expect(documentStore.reviewRunId).toBeNull();
});

it('shows no diff and no Accept while the base is missing', async () => {
  const host = await openWith([candidate('a')], undefined, (sha) =>
    sha === 'base-sha' ? null : PROPOSAL,
  );
  openDocumentCompare('run-1');
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());

  expect(button(host, 'Accept').disabled).toBe(true);
  expect(host.querySelector('.is-added, .is-changed')).toBeNull();
});

it('shows a compact error when a version cannot be read', async () => {
  const host = await openWith([candidate('a')], undefined, (sha) => {
    if (sha === 'sha-a') throw new Error('git exploded');
    return BASE;
  });
  openDocumentCompare('run-1');
  await vi.waitFor(() =>
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('git exploded'),
  );
  expect(button(host, 'Accept').disabled).toBe(true);
});

it('says in the bar why Accept is off once the run is stale', async () => {
  await openWith([candidate('a')]);
  const host = document.createElement('div');
  document.body.append(host);
  const stale = { ...run([candidate('a')]), status: 'stale' as const };
  const disposeStale = render(
    () => <InlineReview run={stale} candidate={stale.candidates[0]} />,
    host,
  );

  expect(button(host, 'Accept').disabled).toBe(true);
  expect(host.querySelector('.docws-inline-review-bar')?.textContent).toContain(
    'The document moved since this run',
  );
  disposeStale();
});
