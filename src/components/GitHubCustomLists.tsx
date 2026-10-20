import { For, Show, createMemo, createSignal, createUniqueId, onCleanup } from 'solid-js';
import type { GitHubCustomList } from '../../electron/shared/github-list';
import { errMessage } from '../lib/log';
import { ConfirmDialog } from './ConfirmDialog';
import { SparkleIcon, TrashIcon } from './icons';
import { store } from '../store/core';
import { GITHUB_BATCH_LIMIT, readGitHubIssue, startGitHubTriageTask } from '../store/github';
import {
  deleteGitHubList,
  loadGitHubLists,
  showGitHubList,
  type ShownGitHubList,
} from '../store/github-lists';

/** Tracked: re-read whenever a list is published or deleted. */
function savedLists(
  projectId: string,
  repository: string,
): { lists: GitHubCustomList[]; error: string } {
  try {
    return { lists: loadGitHubLists(projectId, repository), error: '' };
  } catch (err) {
    return { lists: [], error: `Could not load saved lists: ${errMessage(err)}` };
  }
}

/** Switches the page between search results and a saved agent list. */
export function GitHubListPicker(props: {
  projectId: string;
  repository: string;
  shown: ShownGitHubList | null;
}) {
  const saved = createMemo(() => savedLists(props.projectId, props.repository));
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  return (
    <Show when={saved().lists.length || saved().error}>
      <div class="github-custom-list-controls">
        <label>
          Show
          <select
            aria-label="Shown list"
            value={props.shown?.name ?? ''}
            onChange={(e) => {
              const name = e.currentTarget.value;
              showGitHubList(
                name ? { projectId: props.projectId, repository: props.repository, name } : null,
              );
            }}
          >
            <option value="">Search results</option>
            <For each={saved().lists}>
              {(list) => <option value={list.name}>{list.name}</option>}
            </For>
          </select>
        </label>
        <Show when={props.shown}>
          {(shown) => (
            <>
              <button type="button" onClick={() => setConfirmDelete(true)}>
                <TrashIcon /> Delete list
              </button>
              <ConfirmDialog
                open={confirmDelete()}
                title="Delete list?"
                message={`Delete the list "${shown().name}"? The agent can publish it again.`}
                confirmLabel="Delete"
                danger
                onConfirm={() => {
                  setConfirmDelete(false);
                  deleteGitHubList(props.projectId, shown().repository, shown().name);
                }}
                onCancel={() => setConfirmDelete(false)}
              />
            </>
          )}
        </Show>
        <Show when={saved().error}>
          <p role="alert">{saved().error}</p>
        </Show>
      </div>
    </Show>
  );
}

/** Looks up the shown list; undefined once it was deleted or never saved. */
export function useShownGitHubList(shown: () => ShownGitHubList | null) {
  const list = createMemo(() => {
    const s = shown();
    return s
      ? savedLists(s.projectId, s.repository).lists.find((l) => l.name === s.name)
      : undefined;
  });
  return list;
}

function triageNote(group: GitHubCustomList['groups'][number]): string {
  if (group.items.length > GITHUB_BATCH_LIMIT)
    return `Batch triage takes up to ${GITHUB_BATCH_LIMIT} items.`;
  if (store.showNewTaskPanel) return 'Finish or dismiss your task draft first.';
  return '';
}

/** An agent's ordered, grouped list, shown in place of search results. */
export function GitHubListView(props: {
  projectId: string;
  list: GitHubCustomList;
  selectedUrl: string | null;
  onOpen: (url: string) => void;
}) {
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  async function triageGroup(group: GitHubCustomList['groups'][number]) {
    if (busy() || store.showNewTaskPanel) return;
    setBusy(true);
    setError('');
    try {
      const items = await Promise.all(group.items.map((item) => readGitHubIssue(item.url)));
      if (!disposed && !startGitHubTriageTask(props.projectId, items))
        setError('Finish or dismiss your task draft first.');
    } catch (err) {
      if (!disposed) setError(`Could not read group items: ${errMessage(err)}`);
    } finally {
      if (!disposed) setBusy(false);
    }
  }
  return (
    <div class="github-custom-list-groups">
      <h3>{props.list.name}</h3>
      <small>Agent ordering; open an item for its current GitHub details.</small>
      <Show when={busy()}>
        <p role="status">Loading list items…</p>
      </Show>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <Show when={!props.list.groups.length}>
        <p>This list has no groups.</p>
      </Show>
      <For each={props.list.groups}>
        {(group, groupIndex) => {
          const noteId = createUniqueId();
          const note = createMemo(() => triageNote(group));
          return (
            <section aria-label={group.name}>
              <div class="github-custom-list-group-head">
                <h4>
                  {groupIndex() + 1}. {group.name}
                </h4>
                <button
                  type="button"
                  aria-label={`Triage group with agent: ${group.name}`}
                  title="Triage this group with the agent"
                  aria-describedby={note() ? noteId : undefined}
                  disabled={busy() || !!note()}
                  onClick={() => void triageGroup(group)}
                >
                  <SparkleIcon /> Triage group
                </button>
                <Show when={note()}>
                  <small id={noteId}>{note()}</small>
                </Show>
              </div>
              <ol>
                <For each={group.items}>
                  {(item) => (
                    <li>
                      <button
                        type="button"
                        class="github-issue-row"
                        aria-pressed={props.selectedUrl === item.url}
                        onClick={() => props.onOpen(item.url)}
                      >
                        <strong>
                          {item.title} · #{item.url.split('/').pop()}
                        </strong>
                        <span class="github-issue-row-meta">{item.reason}</span>
                      </button>
                    </li>
                  )}
                </For>
              </ol>
            </section>
          );
        }}
      </For>
    </div>
  );
}
