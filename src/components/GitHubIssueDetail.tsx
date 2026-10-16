import { For, Show, createMemo, createResource, createSignal } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import type { GitHubIssueChange } from '../ipc/types';
import { errMessage } from '../lib/log';
import { invoke } from '../lib/ipc';
import { sameGitHubIssue } from '../lib/github-url';
import { store } from '../store/core';
import { setActiveTask } from '../store/navigation';
import { uncollapseTask } from '../store/tasks';
import {
  openGitHubIssues,
  readGitHubIssue,
  readGitHubIssueActivity,
  startGitHubIssueTask,
  updateGitHubIssue,
} from '../store/github';
import { addIssuesToBoard, issueBoardColumn, openKanban } from '../store/kanban';
import { GitHubItemBadges } from './GitHubItemBadges';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CheckIcon,
  ExternalLinkIcon,
  PencilIcon,
  PersonIcon,
  KanbanIcon,
  PlayIcon,
  SyncIcon,
} from './icons';
import { renderChatMarkdown } from './chat/chat-markdown';

export function GitHubIssueDetail(props: {
  url: string;
  projectId: string;
  onChanged: () => void;
}) {
  const [issue, { mutate, refetch }] = createResource(() => props.url, readGitHubIssue);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [editing, setEditing] = createSignal<'labels' | 'assignees' | null>(null);
  const [metadata, setMetadata] = createSignal('');
  const [closeReason, setCloseReason] = createSignal<'completed' | 'not_planned'>('completed');
  const [activityPage, setActivityPage] = createSignal(1);
  const [revision, setRevision] = createSignal(0);
  const [activity] = createResource(
    () => ({ url: props.url, page: activityPage(), revision: revision() }),
    ({ url, page }) => readGitHubIssueActivity(url, page),
  );
  // Reading an errored resource throws to the app-wide ErrorBoundary; show the error inline instead.
  const loadedIssue = () => (issue.error ? undefined : issue());
  const [boardColumn, { refetch: refetchBoardColumn }] = createResource(
    () => ({ projectId: props.projectId, url: props.url }),
    ({ projectId, url }) => issueBoardColumn(projectId, url),
  );
  const [addingToBoard, setAddingToBoard] = createSignal(false);
  async function addToBoard(item: { title: string; url: string }) {
    setAddingToBoard(true);
    try {
      await addIssuesToBoard(props.projectId, [item]);
      await refetchBoardColumn();
    } finally {
      setAddingToBoard(false);
    }
  }
  const linkedTasks = createMemo(() =>
    Object.values(store.tasks).filter(
      (t) => sameGitHubIssue(t.githubUrl, props.url) || sameGitHubIssue(t.prUrl, props.url),
    ),
  );

  async function change(value: GitHubIssueChange) {
    if (busy()) return;
    setBusy(true);
    setError('');
    try {
      const updated = await updateGitHubIssue(props.url, value);
      mutate({
        ...updated,
        baseRefName: loadedIssue()?.baseRefName,
        isCrossRepository: loadedIssue()?.isCrossRepository,
      });
      setEditing(null);
      setRevision((v) => v + 1);
      props.onChanged();
    } catch (err) {
      setError(`Could not update issue: ${errMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }
  function external(url: string) {
    void invoke(IPC.ShellOpenExternal, { url }).catch((err: unknown) => setError(errMessage(err)));
  }
  function refresh() {
    void refetch();
    setRevision((v) => v + 1);
  }
  return (
    <div class="github-issue-detail-body">
      <Show when={issue.loading}>
        <p role="status">Loading issue…</p>
      </Show>
      <Show when={issue.error}>
        <p role="alert" class="github-issues-error">
          {errMessage(issue.error)} <button onClick={refresh}>Retry</button>
        </p>
      </Show>
      <Show when={error()}>
        <p role="alert" class="github-issues-error">
          {error()}
        </p>
      </Show>
      <Show when={loadedIssue()}>
        {(current) => (
          <>
            <div class="github-issues-actions">
              <span class={`github-issue-state ${current().state}`}>
                {current().state} · #{current().number}
              </span>
              <button onClick={() => external(current().url)}>
                <ExternalLinkIcon /> Open in GitHub
              </button>
              <button disabled={busy() || !!editing() || issue.loading} onClick={refresh}>
                <SyncIcon /> Refresh issue
              </button>
            </div>
            <h2>{current().title}</h2>
            <GitHubItemBadges item={current()} />
            <p class="github-issue-byline">Opened by @{current().author}</p>
            <div class="github-issue-workspace-actions">
              <For each={linkedTasks()}>
                {(task) => (
                  <button
                    onClick={() => {
                      openGitHubIssues(null);
                      if (task.collapsed) uncollapseTask(task.id);
                      setActiveTask(task.id);
                    }}
                  >
                    Open task: {task.name} <ExternalLinkIcon />
                  </button>
                )}
              </For>
              <button
                class="github-issue-primary"
                disabled={busy() || issue.loading || !!issue.error || store.showNewTaskPanel}
                onClick={() => startGitHubIssueTask(props.projectId, current())}
              >
                <PlayIcon size={12} />{' '}
                {linkedTasks().length
                  ? 'Start another task'
                  : current().kind === 'pr'
                    ? 'Review with agent'
                    : 'Start task'}
              </button>
              <Show
                when={!boardColumn.error && boardColumn()}
                fallback={
                  <button
                    disabled={addingToBoard() || boardColumn.loading}
                    title="Add a card for this item to the project's Kanban board (KANBAN.md)"
                    onClick={() => void addToBoard(current())}
                  >
                    <KanbanIcon size={12} /> Add to board
                  </button>
                }
              >
                {(column) => (
                  <button
                    title="Open the project's Kanban board"
                    onClick={() => openKanban(props.projectId)}
                  >
                    <KanbanIcon size={12} /> On board · {column()}
                  </button>
                )}
              </Show>
              <small>
                {store.showNewTaskPanel
                  ? 'Finish or dismiss your open task draft before starting another.'
                  : 'Task context includes the description and issue link.'}
              </small>
              <Show when={current().body.length > 8_000}>
                <small>
                  The description is long; task context will include an excerpt and a link to the
                  full issue.
                </small>
              </Show>
            </div>
            <fieldset
              class="github-issue-triage"
              disabled={busy() || issue.loading || !!issue.error}
            >
              <legend>Triage</legend>
              <For each={['labels', 'assignees'] as const}>
                {(field) => (
                  <div class="github-issue-metadata">
                    <strong>{field === 'labels' ? 'Labels' : 'Assignees'}</strong>
                    <span>{current()[field].join(', ') || 'None'}</span>
                    <button
                      disabled={!!editing()}
                      onClick={() => {
                        setMetadata(current()[field].join('\n'));
                        setEditing(field);
                      }}
                    >
                      {field === 'labels' ? <PencilIcon /> : <PersonIcon />} Edit {field}
                    </button>
                  </div>
                )}
              </For>
              <Show when={editing()}>
                {(field) => (
                  <form
                    class="github-issue-edit"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void change({
                        field: field(),
                        values: metadata()
                          .split('\n')
                          .map((v) => v.trim())
                          .filter(Boolean),
                      });
                    }}
                  >
                    <label for="github-issue-metadata">
                      {field() === 'labels' ? 'Label names' : 'GitHub usernames'} (one per line;
                      empty removes all)
                    </label>
                    <textarea
                      id="github-issue-metadata"
                      value={metadata()}
                      onInput={(e) => setMetadata(e.currentTarget.value)}
                      rows={3}
                    />
                    <div class="github-issues-actions">
                      <button type="submit">Save {field()}</button>
                      <button type="button" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
              </Show>
              <div class="github-issues-actions">
                <Show when={current().kind === 'issue'}>
                  <Show
                    when={current().state === 'open'}
                    fallback={
                      <button
                        disabled={!!editing()}
                        onClick={() => void change({ field: 'state', value: 'open' })}
                      >
                        Reopen issue
                      </button>
                    }
                  >
                    <select
                      aria-label="Close reason"
                      value={closeReason()}
                      onChange={(e) =>
                        setCloseReason(e.currentTarget.value as 'completed' | 'not_planned')
                      }
                    >
                      <option value="completed">Completed</option>
                      <option value="not_planned">Not planned</option>
                    </select>
                    <button
                      disabled={!!editing()}
                      onClick={() =>
                        void change({ field: 'state', value: 'closed', reason: closeReason() })
                      }
                    >
                      <CheckIcon /> Close issue
                    </button>
                  </Show>
                </Show>
                <Show when={busy()}>
                  <span role="status">Saving to GitHub…</span>
                </Show>
              </div>
            </fieldset>
            <h3>Description</h3>
            <IssueMarkdown
              body={current().body || '_No description provided._'}
              onOpen={external}
            />
            <h3>Activity</h3>
            <Show when={activity.loading}>
              <p role="status">Loading activity…</p>
            </Show>
            <Show when={activity.error}>
              <p role="alert" class="github-issues-error">
                {errMessage(activity.error)}{' '}
                <button onClick={() => setRevision((v) => v + 1)}>Retry activity</button>
              </p>
            </Show>
            <Show when={!activity.loading && !activity.error}>
              <Show when={!activity()?.items.length}>
                <p>No activity on this page.</p>
              </Show>
              <For each={activity()?.items}>
                {(item) => (
                  <article class="github-issue-activity">
                    <div class="github-issue-byline">
                      <strong>@{item.author}</strong> {item.event}{' '}
                      <time>{item.createdAt ? new Date(item.createdAt).toLocaleString() : ''}</time>
                    </div>
                    <Show when={item.body}>
                      <IssueMarkdown body={item.body} onOpen={external} />
                    </Show>
                  </article>
                )}
              </For>
            </Show>
            <div class="github-issues-pagination">
              <button
                disabled={activity.loading || activityPage() <= 1}
                onClick={() => setActivityPage((p) => p - 1)}
              >
                <ChevronLeftIcon /> Previous activity
              </button>
              <span>Page {activityPage()}</span>
              <button
                disabled={activity.loading || !!activity.error || !activity()?.hasMore}
                onClick={() => setActivityPage((p) => p + 1)}
              >
                Next activity <ChevronRightIcon />
              </button>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}

function IssueMarkdown(props: { body: string; onOpen: (url: string) => void }) {
  const html = createMemo(() => renderChatMarkdown(props.body));
  return (
    <div
      class="github-issue-markdown"
      onClick={(e) => {
        const link = (e.target as HTMLElement).closest('a');
        if (!link) return;
        e.preventDefault();
        const url = link.getAttribute('href') ?? '';
        if (/^https?:\/\//i.test(url)) props.onOpen(url);
      }}
      // eslint-disable-next-line solid/no-innerhtml -- renderChatMarkdown sanitizes untrusted GitHub content.
      innerHTML={html()}
    />
  );
}
