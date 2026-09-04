import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  untrack,
} from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { diffBlocks, type BlockChange, type DocumentBlock } from './markdown-blocks';
import {
  acceptDocumentCandidate,
  documentStore,
  rejectDocumentRun,
  setDocumentCandidateNote,
} from './store';
import { getProject } from '../store/projects';
import type { DocumentCandidateRecord, DocumentRunRecord } from './types';
import { DocumentViewer, type BlockRange } from './DocumentViewer';
import { SourceDiff } from './SourceDiff';
import { createRenderedBlocks } from './use-blocks';

function projectRoot(): string {
  const project = documentStore.projectId ? getProject(documentStore.projectId) : undefined;
  return project?.path ?? '';
}

async function fetchDocumentAt(sha: string, documentPath: string): Promise<string | null> {
  return invoke<string | null>(IPC.GetDocumentAtCommit, {
    projectRoot: projectRoot(),
    sha,
    documentPath,
  });
}

/** Blocks that lie inside the run's line scope at the base commit. */
function scopeRange(blocks: readonly DocumentBlock[], run: DocumentRunRecord): BlockRange | null {
  if (run.scope.wholeDocument || blocks.length === 0) return null;
  let start = -1;
  let end = -1;
  blocks.forEach((b, i) => {
    if (b.endLine >= run.scope.startLine && b.startLine <= run.scope.endLine) {
      if (start === -1) start = i;
      end = i;
    }
  });
  return start === -1 ? null : { start, end };
}

function ChangeNav(props: { body: () => HTMLDivElement | undefined; count: number }) {
  const [cursor, setCursor] = createSignal(-1);
  function go(delta: number) {
    const body = props.body();
    if (!body) return;
    const targets = body.querySelectorAll<HTMLElement>('.doc-block:not([data-change="same"])');
    if (targets.length === 0) return;
    const next = (cursor() + delta + targets.length) % targets.length;
    setCursor(next);
    targets[next].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  return (
    <span class="docws-nav">
      <button
        type="button"
        class="docws-btn docws-btn-sm"
        onClick={() => go(-1)}
        title="Previous change"
      >
        ‹
      </button>
      <span>
        {props.count} changed block{props.count === 1 ? '' : 's'}
      </span>
      <button
        type="button"
        class="docws-btn docws-btn-sm"
        onClick={() => go(1)}
        title="Next change"
      >
        ›
      </button>
    </span>
  );
}

function Rationale(props: { candidate: DocumentCandidateRecord }) {
  const r = () => props.candidate.rationale;
  const list = (label: string, items: string[] | undefined, cls?: string) => (
    <Show when={items && items.length > 0}>
      <div class="docws-rationale-label">{label}</div>
      <ul class={cls}>
        <For each={items}>{(item) => <li>{item}</li>}</For>
      </ul>
    </Show>
  );
  return (
    <div class="docws-rationale">
      <div class="docws-rationale-summary">{r()?.summary ?? 'No rationale returned.'}</div>
      {list('Changes', r()?.changes)}
      {list('Assumptions', r()?.assumptions)}
      {list('Open questions', r()?.questions)}
      {list('Warnings', r()?.warnings, 'docws-warning')}
      <Show when={props.candidate.outOfScopeFiles?.length}>
        <div class="docws-warning">
          Touched files outside the document (reverted):{' '}
          {props.candidate.outOfScopeFiles?.join(', ')}
        </div>
      </Show>
      <Show when={props.candidate.outOfScopeHunks}>
        <div class="docws-warning">
          {props.candidate.outOfScopeHunks} change{props.candidate.outOfScopeHunks === 1 ? '' : 's'}{' '}
          outside the selected passage.
        </div>
      </Show>
      <Show when={props.candidate.error}>
        <div class="docws-error">{props.candidate.error}</div>
      </Show>
    </div>
  );
}

function CandidateColumn(props: {
  run: DocumentRunRecord;
  candidate: DocumentCandidateRecord;
  baseBlocks: DocumentBlock[];
  revealAgents: boolean;
  showSource: boolean;
  /** Reports which base blocks this candidate changed or removed. */
  onBaseChanges: (candidateId: string, changes: BlockChange[]) => void;
}) {
  let bodyRef: HTMLDivElement | undefined;
  const [content] = createResource(
    () =>
      props.candidate.commitSha
        ? { sha: props.candidate.commitSha, path: props.run.documentPath }
        : null,
    ({ sha, path }) => fetchDocumentAt(sha, path),
  );
  const rendered = createRenderedBlocks(() => content() ?? null);
  const blockDiff = createMemo(() => diffBlocks(props.baseBlocks, rendered.blocks()));
  const changes = () => blockDiff().candidate;
  const changedCount = () => changes().filter((c) => c !== 'same').length;
  createEffect(() => {
    if (rendered.blocks().length > 0) props.onBaseChanges(props.candidate.id, blockDiff().base);
  });
  const [diff] = createResource(
    () =>
      props.showSource && props.candidate.commitSha
        ? {
            projectRoot: projectRoot(),
            from: props.run.baseSha,
            to: props.candidate.commitSha,
            documentPath: props.run.documentPath,
          }
        : null,
    (args) => invoke<string>(IPC.GetDocumentDiff, args),
  );
  const [note, setNote] = createSignal(untrack(() => props.candidate.note ?? ''));
  const [accepting, setAccepting] = createSignal(false);
  const canAccept = () =>
    !!props.candidate.commitSha && props.run.status === 'finished' && !accepting();
  const title = () =>
    props.revealAgents
      ? `${props.candidate.agentName}${props.candidate.isMain ? ' · main session' : ''}`
      : `Candidate ${props.candidate.label}`;

  async function accept() {
    setAccepting(true);
    try {
      await acceptDocumentCandidate(props.run.id, props.candidate.id);
    } finally {
      setAccepting(false);
    }
  }

  return (
    <section class="docws-column" aria-label={title()}>
      <div class="docws-column-head">
        <div class="docws-column-title">
          <span class="docws-candidate-label">{props.candidate.label}</span>
          <span>{title()}</span>
          <span style={{ 'margin-left': 'auto' }}>
            <ChangeNav body={() => bodyRef} count={changedCount()} />
          </span>
        </div>
        <Rationale candidate={props.candidate} />
        <textarea
          class="docws-note"
          placeholder="Your note on this candidate…"
          value={note()}
          onInput={(e) => setNote(e.currentTarget.value)}
          onBlur={() => {
            if (note() !== (props.candidate.note ?? ''))
              void setDocumentCandidateNote(props.run.id, props.candidate.id, note());
          }}
        />
        <div class="docws-run-actions">
          <button
            type="button"
            class="docws-btn docws-btn-sm docws-btn-primary"
            disabled={!canAccept()}
            title={
              props.run.status === 'stale'
                ? 'The document moved since this run and the proposal no longer applies. Re-run it.'
                : 'Accept this candidate as one commit on the canonical branch'
            }
            onClick={() => void accept()}
          >
            {accepting() ? 'Accepting…' : 'Accept this candidate'}
          </button>
        </div>
      </div>
      <div class="docws-column-body" ref={bodyRef}>
        <Show
          when={props.candidate.commitSha}
          fallback={<div class="docws-empty">No change proposed.</div>}
        >
          <Show
            when={!props.showSource}
            fallback={
              <Show when={!diff.loading} fallback={<div class="docws-empty">Loading diff…</div>}>
                <SourceDiff raw={diff() ?? ''} />
              </Show>
            }
          >
            <Show
              when={!rendered.rendering() || rendered.blocks().length > 0}
              fallback={<div class="docws-empty">Rendering…</div>}
            >
              <DocumentViewer
                blocks={rendered.blocks()}
                changes={changes()}
                renderKey={`cand-${props.candidate.id}`}
              />
            </Show>
          </Show>
        </Show>
      </div>
    </section>
  );
}

/** Base on the left, candidates to the right, each opening with its rationale. */
export function CompareView(props: { run: DocumentRunRecord }) {
  const [revealAgents, setRevealAgents] = createSignal(false);
  const [showSource, setShowSource] = createSignal(false);
  const [baseContent] = createResource(
    () => ({ sha: props.run.baseSha, path: props.run.documentPath }),
    ({ sha, path }) => fetchDocumentAt(sha, path),
  );
  const base = createRenderedBlocks(() => baseContent() ?? null);
  const scope = createMemo(() => scopeRange(base.blocks(), props.run));
  const candidates = createMemo(() => props.run.candidates.filter((c) => c.commitSha));
  // Base blocks touched by any candidate, so a deleted paragraph is visible somewhere.
  const [baseChanges, setBaseChanges] = createSignal<Record<string, BlockChange[]>>({});
  const baseMarks = createMemo<BlockChange[]>(() => {
    const perCandidate = Object.values(baseChanges());
    return base.blocks().map((_, i) => {
      const marks = perCandidate.map((m) => m[i]).filter((m): m is BlockChange => !!m);
      if (marks.includes('removed')) return 'removed';
      if (marks.includes('changed')) return 'changed';
      return 'same';
    });
  });
  const scopeText = () => {
    const s = props.run.scope;
    if (s.wholeDocument) return 'whole document';
    return `L${s.startLine}–${s.endLine}${s.heading ? ` · ${s.heading}` : ''}`;
  };

  return (
    <div class="docws-compare">
      <div class="docws-compare-bar">
        <span class="docws-instruction" title={props.run.instruction}>
          “{props.run.instruction}”
        </span>
        <span>{scopeText()}</span>
        <span>base {props.run.baseSha.slice(0, 7)}</span>
        <Show when={props.run.status === 'stale'}>
          <span class="docws-warning">stale: the document moved since this run</span>
        </Show>
        <span style={{ 'margin-left': 'auto' }} />
        <label class="docws-toggle">
          <input
            type="checkbox"
            checked={revealAgents()}
            onChange={(e) => setRevealAgents(e.currentTarget.checked)}
          />
          Show agents
        </label>
        <label class="docws-toggle">
          <input
            type="checkbox"
            checked={showSource()}
            onChange={(e) => setShowSource(e.currentTarget.checked)}
          />
          Source diff
        </label>
        <button
          type="button"
          class="docws-btn docws-btn-sm docws-btn-danger"
          onClick={() => void rejectDocumentRun(props.run.id)}
        >
          Reject all
        </button>
      </div>
      <div class="docws-columns">
        <section class="docws-column docws-column-base" aria-label="Base version">
          <div class="docws-column-head">
            <div class="docws-column-title">Base · {props.run.baseSha.slice(0, 7)}</div>
            <div class="docws-rationale">
              <div>
                The document as every candidate saw it. The scoped passage is outlined; blocks a
                candidate rewrote or removed are marked.
              </div>
            </div>
          </div>
          <div class="docws-column-body">
            <DocumentViewer
              blocks={base.blocks()}
              scope={scope()}
              changes={baseMarks()}
              renderKey="base"
            />
          </div>
        </section>
        <For each={candidates()}>
          {(candidate) => (
            <CandidateColumn
              run={props.run}
              candidate={candidate}
              baseBlocks={base.blocks()}
              revealAgents={revealAgents()}
              showSource={showSource()}
              onBaseChanges={(id, marks) => setBaseChanges((prev) => ({ ...prev, [id]: marks }))}
            />
          )}
        </For>
      </div>
    </div>
  );
}
