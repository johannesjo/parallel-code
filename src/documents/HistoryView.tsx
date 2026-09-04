import { For, Show, createResource, createSignal, onCleanup } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { confirm } from '../lib/dialog';
import { formatRelativeAge } from '../lib/relativeAge';
import { documentStore, revertDocumentCommit } from './store';
import { getProject } from '../store/projects';
import type { DocumentHistoryEntry } from './types';
import { DocumentViewer } from './DocumentViewer';
import { SourceDiff } from './SourceDiff';
import { createRenderedBlocks } from './use-blocks';

function project() {
  return documentStore.projectId ? getProject(documentStore.projectId) : undefined;
}

function EntryDetail(props: {
  entry: DocumentHistoryEntry;
  documentPath: string;
  onReverted: () => void;
}) {
  const [mode, setMode] = createSignal<'diff' | 'version'>('diff');
  const root = () => project()?.path ?? '';
  const [diff] = createResource(
    () => ({
      projectRoot: root(),
      from: `${props.entry.sha}^`,
      to: props.entry.sha,
      documentPath: props.documentPath,
    }),
    (args) => invoke<string>(IPC.GetDocumentDiff, args),
  );
  const [content] = createResource(
    () =>
      mode() === 'version'
        ? { projectRoot: root(), sha: props.entry.sha, documentPath: props.documentPath }
        : null,
    (args) => invoke<string | null>(IPC.GetDocumentAtCommit, args),
  );
  const rendered = createRenderedBlocks(() => content() ?? null);
  const trailerEntries = () => Object.entries(props.entry.trailers);

  async function revert() {
    const ok = await confirm(
      `Revert "${props.entry.subject}"? This adds a new commit that undoes it.`,
      {
        okLabel: 'Revert',
        kind: 'warning',
      },
    );
    if (!ok) return;
    if (await revertDocumentCommit(props.entry.sha)) props.onReverted();
  }

  return (
    <div class="docws-history-detail">
      <div class="docws-history-detail-head">
        <div class="docws-column-title">
          <span>{props.entry.subject}</span>
          <span style={{ 'margin-left': 'auto' }} class="docws-tabs">
            <button
              type="button"
              class="docws-tab"
              aria-selected={mode() === 'diff'}
              onClick={() => setMode('diff')}
            >
              Diff
            </button>
            <button
              type="button"
              class="docws-tab"
              aria-selected={mode() === 'version'}
              onClick={() => setMode('version')}
            >
              Version
            </button>
          </span>
        </div>
        <div class="docws-history-meta">
          <span>{props.entry.shortSha}</span>
          <span>{props.entry.author}</span>
          <span>{new Date(props.entry.timestamp * 1000).toLocaleString()}</span>
          <span class="docws-badge">
            {props.entry.manual ? 'manual' : props.entry.trailers.Agent}
          </span>
        </div>
        <Show when={props.entry.body}>
          <div class="docws-history-body">{props.entry.body}</div>
        </Show>
        <Show when={trailerEntries().length > 0}>
          <dl class="docws-trailers">
            <For each={trailerEntries()}>
              {([key, value]) => (
                <>
                  <dt>{key}</dt>
                  <dd>{value}</dd>
                </>
              )}
            </For>
          </dl>
        </Show>
        <div class="docws-run-actions">
          <button
            type="button"
            class="docws-btn docws-btn-sm docws-btn-danger"
            onClick={() => void revert()}
          >
            Revert this commit
          </button>
        </div>
      </div>
      <Show when={mode() === 'version'}>
        <div class="docws-older-banner">
          Older version at {props.entry.shortSha}. The current document is on the Document tab.
        </div>
      </Show>
      <div class="docws-column-body">
        <Show
          when={mode() === 'diff'}
          fallback={
            <DocumentViewer blocks={rendered.blocks()} renderKey={`hist-${props.entry.shortSha}`} />
          }
        >
          <Show when={!diff.loading} fallback={<div class="docws-empty">Loading diff…</div>}>
            <SourceDiff raw={diff() ?? ''} />
          </Show>
        </Show>
      </div>
    </div>
  );
}

/** `git log` for the document with the Parallel trailers parsed into prose. */
export function HistoryView() {
  const [wholeProject, setWholeProject] = createSignal(false);
  const [selectedSha, setSelectedSha] = createSignal<string | null>(null);
  const [version, setVersion] = createSignal(0);
  const documentPath = () => project()?.documentPath ?? '';
  const [entries, { refetch }] = createResource(
    () => ({
      root: project()?.path,
      documentPath: documentPath(),
      whole: wholeProject(),
      head: documentStore.snapshot?.headSha,
      version: version(),
    }),
    async ({ root, documentPath: docPath, whole }) => {
      if (!root || !docPath) return [] as DocumentHistoryEntry[];
      return invoke<DocumentHistoryEntry[]>(IPC.GetDocumentHistory, {
        projectRoot: root,
        documentPath: docPath,
        wholeProject: whole,
      });
    },
  );
  const selected = () => entries()?.find((e) => e.sha === selectedSha()) ?? entries()?.[0] ?? null;
  const [nowMs, setNowMs] = createSignal(Date.now());
  const clock = setInterval(() => setNowMs(Date.now()), 30_000);
  onCleanup(() => clearInterval(clock));

  return (
    <div class="docws-history">
      <div class="docws-history-list" role="listbox" aria-label="History">
        <div class="docws-compare-bar">
          <label class="docws-toggle">
            <input
              type="checkbox"
              checked={wholeProject()}
              onChange={(e) => setWholeProject(e.currentTarget.checked)}
            />
            Whole project
          </label>
          <span style={{ 'margin-left': 'auto' }}>{entries()?.length ?? 0} commits</span>
        </div>
        <Show when={entries()?.length === 0}>
          <div class="docws-empty" style={{ padding: '12px 14px' }}>
            No commits touch this document yet.
          </div>
        </Show>
        <For each={entries() ?? []}>
          {(entry) => (
            <button
              type="button"
              role="option"
              class="docws-history-entry"
              aria-selected={selected()?.sha === entry.sha}
              onClick={() => setSelectedSha(entry.sha)}
            >
              <span class="docws-history-subject">{entry.subject}</span>
              <span class="docws-history-meta">
                <span>{entry.shortSha}</span>
                <span>{formatRelativeAge(entry.timestamp * 1000, nowMs())}</span>
                <span class="docws-badge">{entry.manual ? 'manual' : entry.trailers.Agent}</span>
                <Show when={entry.trailers.Candidate}>
                  <span>candidate {entry.trailers.Candidate}</span>
                </Show>
              </span>
            </button>
          )}
        </For>
      </div>
      <Show when={selected()} keyed>
        {(entry) => (
          <EntryDetail
            entry={entry}
            documentPath={documentPath()}
            onReverted={() => {
              setVersion((v) => v + 1);
              void refetch();
            }}
          />
        )}
      </Show>
    </div>
  );
}
