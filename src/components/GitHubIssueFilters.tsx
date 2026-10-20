import { For, Show, createSignal, onCleanup } from 'solid-js';
import { createStore } from 'solid-js/store';
import { TRIAGE_KINDS, TRIAGE_SORTS } from '../../electron/shared/github-triage';
import type { TriageKind, TriageSort } from '../../electron/shared/github-triage';
import type { GitHubIssueQuery } from '../ipc/types';
import type { BrowserSession } from './github-issues-session';
import { CloseIcon } from './icons';

type TextFilter = 'search' | 'label' | 'assignee' | 'author';

/** Filter inputs are edited as a draft; changeFilters commits them to the query at page 1. */
export function createIssueFilters(
  query: GitHubIssueQuery,
  commit: (query: GitHubIssueQuery) => void,
  currentQuery: () => GitHubIssueQuery,
) {
  const [draft, setDraft] = createStore({
    search: query.search,
    label: query.label,
    assignee: query.assignee,
    author: query.author,
  });
  const [customAssignee, setCustomAssignee] = createSignal(
    !!query.assignee && !['@none', '@me'].includes(query.assignee),
  );
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(searchTimer));
  function changeFilters(patch: Partial<GitHubIssueQuery> = {}) {
    clearTimeout(searchTimer);
    commit({ ...currentQuery(), ...draft, ...patch, page: 1 });
  }
  function textFilter(key: TextFilter, value: string) {
    setDraft(key, value);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => changeFilters(), 400);
  }
  function resetFilters() {
    setCustomAssignee(false);
    setDraft({ search: '', label: '', assignee: '', author: '' });
    changeFilters({ kind: 'all', state: 'open', sort: 'updated-desc' });
  }
  return {
    draft,
    setDraft,
    customAssignee,
    setCustomAssignee,
    changeFilters,
    textFilter,
    resetFilters,
  };
}
export type IssueFilters = ReturnType<typeof createIssueFilters>;

export function GitHubIssueFilters(props: { view: BrowserSession; filters: IssueFilters }) {
  return (
    <>
      <div class="github-triage-types" role="group" aria-label="Work item type">
        <For each={Object.entries(TRIAGE_KINDS)}>
          {([kind, label]) => (
            <button
              type="button"
              aria-pressed={props.view.query.kind === kind}
              title={
                kind === 'discussion'
                  ? 'Issues with a discussion/question label or Discussion issue type'
                  : undefined
              }
              onClick={() => props.filters.changeFilters({ kind: kind as TriageKind })}
            >
              {label}
            </button>
          )}
        </For>
      </div>
      <form
        class="github-issues-filters"
        onSubmit={(e) => {
          e.preventDefault();
          props.filters.changeFilters();
        }}
      >
        <div class="github-issues-search">
          <input
            name="search"
            type="search"
            aria-label="Search issues"
            placeholder="Search issues and PRs…"
            maxLength={200}
            value={props.filters.draft.search}
            onInput={(e) => props.filters.textFilter('search', e.currentTarget.value)}
          />
          <button type="button" onClick={() => props.filters.resetFilters()}>
            <CloseIcon /> Reset
          </button>
        </div>
        <label>
          State
          <select
            aria-label="Issue state"
            value={props.view.query.state}
            onChange={(e) =>
              props.filters.changeFilters({
                state: e.currentTarget.value as GitHubIssueQuery['state'],
              })
            }
          >
            <option value="open">Open</option>
            <option value="closed">Closed / merged</option>
            <option value="all">All states</option>
          </select>
        </label>
        <label>
          Label
          <select
            aria-label="Filter by label"
            value={props.filters.draft.label}
            onChange={(e) => {
              props.filters.setDraft('label', e.currentTarget.value);
              props.filters.changeFilters();
            }}
          >
            <option value="">Any label</option>
            <option value="@none">No labels</option>
            <For each={props.view.result?.labels ?? []}>
              {(label) => <option value={label}>{label}</option>}
            </For>
          </select>
        </label>
        <label>
          Assignee
          <select
            aria-label="Filter by assignee"
            value={props.filters.customAssignee() ? 'custom' : props.filters.draft.assignee}
            onChange={(e) => {
              const value = e.currentTarget.value;
              props.filters.setCustomAssignee(value === 'custom');
              props.filters.setDraft('assignee', value === 'custom' ? '' : value);
              props.filters.changeFilters();
            }}
          >
            <option value="">Anyone</option>
            <option value="@none">Unassigned</option>
            <option value="@me">Assigned to me</option>
            <option value="custom">Specific user…</option>
          </select>
          <Show when={props.filters.customAssignee()}>
            <input
              aria-label="Assignee username"
              placeholder="GitHub username"
              maxLength={100}
              value={props.filters.draft.assignee}
              onInput={(e) => props.filters.textFilter('assignee', e.currentTarget.value)}
            />
          </Show>
        </label>
        <label>
          Author
          <input
            aria-label="Filter by author"
            placeholder="Anyone"
            maxLength={100}
            value={props.filters.draft.author}
            onInput={(e) => props.filters.textFilter('author', e.currentTarget.value)}
          />
        </label>
        <label>
          Sort
          <select
            aria-label="Sort issues"
            value={props.view.query.sort}
            onChange={(e) =>
              props.filters.changeFilters({ sort: e.currentTarget.value as TriageSort })
            }
          >
            <For each={Object.entries(TRIAGE_SORTS)}>
              {([sort, label]) => <option value={sort}>{label}</option>}
            </For>
          </select>
        </label>
      </form>
    </>
  );
}
