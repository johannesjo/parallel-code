import { For, Show } from 'solid-js';
import type { SetStoreFunction } from 'solid-js/store';
import { store } from '../store/core';
import { GITHUB_BATCH_LIMIT } from '../store/github';
import type { GitHubIssueSummary } from '../ipc/types';
import { sameGitHubIssue } from '../lib/github-url';
import { countLabel } from '../lib/plural';
import { formatRelativeAge } from '../lib/relativeAge';
import { GitHubListView, useShownGitHubList } from './GitHubCustomLists';
import { GitHubIssueDetail } from './GitHubIssueDetail';
import { GitHubItemBadges } from './GitHubItemBadges';
import type { BrowserSession } from './github-issues-session';
import { AlertIcon, ChevronLeftIcon, ChevronRightIcon, ListIcon } from './icons';

export interface GitHubIssueListPaneProps {
  projectId: string;
  view: BrowserSession;
  setView: SetStoreFunction<BrowserSession>;
  shownList: ReturnType<ReturnType<typeof useShownGitHubList>>;
  loading: boolean;
  error: string;
  refresh: () => void;
  page: (delta: number) => void;
  toggleSelected: (item: GitHubIssueSummary) => void;
  listRef: (element: HTMLDivElement) => void;
  onScroll: (scrollTop: number) => void;
}

export function GitHubIssueListPane(props: GitHubIssueListPaneProps) {
  // The visible date follows the sort, so the column explains the order.
  const rowDate = (issue: GitHubIssueSummary) =>
    props.view.query.sort.startsWith('created') ? issue.createdAt : issue.updatedAt;
  return (
    <div class="github-issues-listpane">
      <Show when={props.shownList}>
        {(list) => (
          <section class="github-issues-list" aria-label="Agent list">
            <div class="github-issues-rows">
              <GitHubListView
                projectId={props.projectId}
                list={list()}
                selectedUrl={props.view.selectedUrl}
                onOpen={(url) => props.setView('selectedUrl', url)}
              />
            </div>
          </section>
        )}
      </Show>
      {/* Hidden, not unmounted, so the search keeps its scroll position. */}
      <section
        class="github-issues-list"
        aria-label="Repository issues"
        style={{ display: props.shownList ? 'none' : undefined }}
      >
        <Show when={props.error}>
          <div role="alert" class="github-issues-error">
            <AlertIcon size={14} />
            <span>{props.error}</span>
            <button onClick={() => props.refresh()}>Retry</button>
          </div>
        </Show>
        {/* Before the first result, skeletons stand in for rows; afterwards the
            stale rows stay put (dimmed) so a refresh never pushes the list down. */}
        <Show when={props.loading}>
          <Show
            when={props.view.result}
            fallback={
              <div role="status" class="github-issues-loading">
                Loading issues…
                <span class="github-issues-skeleton" aria-hidden="true" />
                <span class="github-issues-skeleton" aria-hidden="true" />
                <span class="github-issues-skeleton" aria-hidden="true" />
              </div>
            }
          >
            <span role="status" class="dialog-sr-only">
              Loading issues…
            </span>
          </Show>
        </Show>
        <div
          class="github-issues-rows"
          aria-busy={props.loading || undefined}
          ref={props.listRef}
          onScroll={(e) => {
            props.onScroll(e.currentTarget.scrollTop);
          }}
        >
          <Show when={!props.error}>
            <Show when={props.view.result?.items.length === 0}>
              <div class="github-issues-empty">No issues or PRs match these filters.</div>
            </Show>
            <For each={props.view.result?.items}>
              {(issue) => (
                <div class="github-issue-selectable-row">
                  <input
                    type="checkbox"
                    class="github-triage-checkbox"
                    aria-label={`Select #${issue.number}: ${issue.title}`}
                    checked={props.view.selected.some((i) => i.url === issue.url)}
                    disabled={
                      props.view.selected.length >= GITHUB_BATCH_LIMIT &&
                      !props.view.selected.some((i) => i.url === issue.url)
                    }
                    onChange={() => props.toggleSelected(issue)}
                  />
                  <button
                    type="button"
                    class="github-issue-row"
                    aria-pressed={props.view.selectedUrl === issue.url}
                    onClick={() => props.setView('selectedUrl', issue.url)}
                  >
                    <span class="github-issue-row-head">
                      <strong>{issue.title}</strong>
                      <time
                        dateTime={rowDate(issue)}
                        title={`Created ${new Date(issue.createdAt).toLocaleString()}; updated ${new Date(issue.updatedAt).toLocaleString()}`}
                      >
                        {shortDate(rowDate(issue))}
                      </time>
                    </span>
                    <span class="github-issue-row-meta">
                      <span class={`github-issue-state ${issue.state}`}>
                        #{issue.number}
                        {/* Open is the usual case; only the exception is spelled out. */}
                        <Show when={issue.state !== 'open'}> · {issue.state}</Show>
                      </span>
                      <GitHubItemBadges item={issue} />
                      <span>
                        {issue.assignees.length
                          ? issue.assignees.map((a) => `@${a}`).join(', ')
                          : `by @${issue.author}`}
                      </span>
                      <Show when={issue.commentCount}>
                        <span>{countLabel(issue.commentCount, 'comment')}</span>
                      </Show>
                      <Show when={issue.reactionCount}>
                        <span>{countLabel(issue.reactionCount, 'reaction')}</span>
                      </Show>
                      <Show
                        when={Object.values(store.tasks).some(
                          (t) =>
                            sameGitHubIssue(t.githubUrl, issue.url) ||
                            sameGitHubIssue(t.prUrl, issue.url),
                        )}
                      >
                        <span>Task linked</span>
                      </Show>
                    </span>
                    <Show when={issue.labels.length}>
                      <span class="github-issue-labels">
                        <For each={issue.labels}>{(label) => <span>{label}</span>}</For>
                      </span>
                    </Show>
                  </button>
                </div>
              )}
            </For>
          </Show>
        </div>
        <footer class="github-issues-pagination">
          <button
            aria-label="Previous"
            title="Previous page"
            disabled={props.loading || props.view.query.page <= 1}
            onClick={() => props.page(-1)}
          >
            <ChevronLeftIcon />
          </button>
          <span>
            Page {props.view.query.page}
            <Show when={props.view.result}>
              {' '}
              · {countLabel(props.view.result?.total ?? 0, 'item')}
            </Show>
          </span>
          <button
            aria-label="Next"
            title="Next page"
            disabled={props.loading || !!props.error || !props.view.result?.hasMore}
            onClick={() => props.page(1)}
          >
            <ChevronRightIcon />
          </button>
        </footer>
        <Show when={props.view.result?.limited}>
          <small class="github-issues-limit">
            GitHub search results are limited. Narrow your filters to find more issues.
          </small>
        </Show>
      </section>
    </div>
  );
}

export function GitHubIssueDetailPane(props: {
  projectId: string;
  selectedUrl: string | null;
  /** Bumped by the page's Refresh to reload the open item. */
  revision: number;
  refresh: () => void;
}) {
  return (
    <section class="github-issues-detail" aria-label="Issue details">
      <Show
        when={props.selectedUrl}
        keyed
        fallback={
          <div class="github-issues-empty github-issues-detail-empty">
            <ListIcon size={28} />
            <strong>No item selected</strong>
            <p>
              Pick an item to read and triage it, or tick several for an agent to group and
              prioritize.
            </p>
          </div>
        }
      >
        {(url) => (
          <GitHubIssueDetail
            url={url}
            projectId={props.projectId}
            revision={props.revision}
            onChanged={props.refresh}
          />
        )}
      </Show>
    </section>
  );
}

const MONTH_MS = 30 * 24 * 60 * 60 * 1_000;

/** Recent dates read as an age ("3d"); older ones as a date, where an age stops helping. */
function shortDate(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const now = Date.now();
  return now - time < MONTH_MS ? formatRelativeAge(time, now) : new Date(time).toLocaleDateString();
}
