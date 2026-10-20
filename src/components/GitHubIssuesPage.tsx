import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from 'solid-js';
import { createStore } from 'solid-js/store';
import { GitHubListPicker, useShownGitHubList } from './GitHubCustomLists';
import { GitHubAgentPane, createAgentPaneState, type AgentPaneState } from './GitHubAgentPane';
import { GitHubBatchBar } from './GitHubBatchBar';
import { GitHubIssueDetailPane, GitHubIssueListPane } from './GitHubIssuePanes';
import { GitHubIssueFilters, createIssueFilters } from './GitHubIssueFilters';
import type { BrowserSession } from './github-issues-session';
import { ArrowLeftIcon, SyncIcon, SparkleIcon } from './icons';
import { ResizablePanel, type PanelChild } from './ResizablePanel';
import { githubAgentTaskId } from '../documents/task-id';
import { store } from '../store/core';
import { triggerFocus } from '../store/focused-panel';
import { GITHUB_BATCH_LIMIT, browseGitHubIssues, openGitHubIssues } from '../store/github';
import { shownGitHubList } from '../store/github-lists';
import type { GitHubIssueSummary } from '../ipc/types';
import type { Project } from '../store/types';
import { errMessage } from '../lib/log';
import './github-issues.css';

// Side by side, the minimums (issue split 490 + agent 280 + handle 6) need 776px,
// and widths just above that leave the list and detail cramped. Below this width
// the agent overlays the page instead. Keep in sync with the
// @container query in github-issues.css.
const OVERLAY_BELOW_PX = 900;

export function GitHubIssuesPage() {
  const sessions = new Map<string, BrowserSession>();
  const project = createMemo(() =>
    store.projects.find((p) => p.id === store.githubIssuesProjectId),
  );
  function session(id: string): BrowserSession {
    const existing = sessions.get(id);
    if (existing) return existing;
    const value: BrowserSession = {
      query: {
        search: '',
        state: 'open',
        label: '',
        assignee: '',
        author: '',
        kind: 'all',
        sort: 'updated-desc',
        page: 1,
      },
      selected: [],
      selectedUrl: null,
      scrollTop: 0,
    };
    sessions.set(id, value);
    return value;
  }
  return (
    <Show when={project()} keyed>
      {(p) => <GitHubPageLayout project={p} session={session(p.id)} />}
    </Show>
  );
}

function GitHubPageLayout(props: { project: Project; session: BrowserSession }) {
  // The page is keyed by project, so the id never changes under this layout.
  const pane = createAgentPaneState(untrack(() => props.project.id));
  const [overlaid, setOverlaid] = createSignal(false);
  let shell: HTMLDivElement | undefined;
  let agentToggle: HTMLButtonElement | undefined;
  onMount(() => {
    if (!shell || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) =>
      setOverlaid(entry.contentRect.width < OVERLAY_BELOW_PX),
    );
    observer.observe(shell);
    onCleanup(() => observer.disconnect());
  });
  const covered = () => overlaid() && pane.open();
  // The page behind the overlay turns inert, which would drop focus to <body> and
  // keep Escape from reaching the shell. Move focus into the pane, and back to
  // the Agent toggle when the overlay is dismissed.
  createEffect((wasCovered: boolean) => {
    const isCovered = covered();
    if (isCovered && !wasCovered) {
      const taskId = githubAgentTaskId(untrack(() => props.project.id));
      if (store.tasks[taskId]) triggerFocus(`${taskId}:prompt`);
      else shell?.querySelector<HTMLElement>('.github-agent-close')?.focus();
    } else if (!isCovered && wasCovered && untrack(overlaid)) {
      agentToggle?.focus();
    }
    return isCovered;
  }, false);
  // Escape from the pane's header or scrim closes the overlay. Keys typed in the
  // agent's terminal or prompt are left alone: agents use Escape themselves.
  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || e.defaultPrevented || !covered()) return;
    if ((e.target as HTMLElement).closest('.xterm, input, textarea, [contenteditable]')) return;
    pane.setOpen(false);
  }
  // Stable child objects: ResizablePanel keeps a child mounted while it stays in the list.
  const browser: PanelChild = {
    // The split's own minimums (list 220 + detail 260) plus its handle.
    id: 'issues',
    minSize: 490,
    content: () => (
      <IssueBrowser
        project={props.project}
        session={props.session}
        agentPane={pane}
        covered={covered()}
        toggleRef={(element) => (agentToggle = element)}
      />
    ),
  };
  const agent: PanelChild = {
    id: 'agent',
    minSize: 280,
    defaultSize: 420,
    resizeLabel: 'Resize agent pane',
    content: () => <GitHubAgentPane project={props.project} agentPane={pane} />,
  };
  return (
    <div class="github-page-shell" ref={shell} onKeyDown={onKeyDown}>
      <ResizablePanel
        direction="horizontal"
        persistKey="github-agent"
        class="github-page"
        absorberIds={['issues']}
        children={pane.open() ? [browser, agent] : [browser]}
      />
      <Show when={covered()}>
        <div class="github-page-scrim" aria-hidden="true" onClick={() => pane.setOpen(false)} />
      </Show>
    </div>
  );
}

function IssueBrowser(props: {
  project: Project;
  session: BrowserSession;
  agentPane: AgentPaneState;
  // The agent overlays the page; keep keyboard focus out of what it hides.
  covered: boolean;
  toggleRef: (element: HTMLButtonElement) => void;
}) {
  // The parent keys this component by project; take its saved session once.
  const initialSession = untrack(() => props.session);
  const [view, setView] = createStore<BrowserSession>({
    ...initialSession,
    query: { ...initialSession.query },
  });
  const filters = createIssueFilters(
    initialSession.query,
    (query) => {
      restoreScroll = 0;
      setView({ query, selectedUrl: null });
    },
    () => view.query,
  );
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [revision, setRevision] = createSignal(0);
  let listRef: HTMLDivElement | undefined;
  let requestId = 0;
  let disposed = false;
  let restoreScroll = initialSession.scrollTop;
  const shown = () => {
    const list = shownGitHubList();
    return list?.projectId === props.project.id ? list : null;
  };
  const shownList = useShownGitHubList(shown);
  onCleanup(() => {
    disposed = true;
    Object.assign(initialSession, {
      query: { ...view.query },
      result: view.result,
      selected: [...view.selected],
      selectedUrl: view.selectedUrl,
      scrollTop: listRef?.scrollTop ?? view.scrollTop,
    });
  });

  createEffect(() => {
    const query = { ...view.query };
    revision();
    const id = ++requestId;
    setLoading(true);
    setError('');
    void browseGitHubIssues(props.project.path, query)
      .then((result) => {
        if (disposed || id !== requestId) return;
        setView('result', result);
        setLoading(false);
        if (listRef) listRef.scrollTop = restoreScroll;
      })
      .catch((err: unknown) => {
        if (disposed || id !== requestId) return;
        setError(errMessage(err));
        setLoading(false);
      });
  });
  onMount(() => {
    if (listRef) listRef.scrollTop = restoreScroll;
  });

  function toggleSelected(item: GitHubIssueSummary) {
    setView('selected', (selected) =>
      selected.some((i) => i.url === item.url)
        ? selected.filter((i) => i.url !== item.url)
        : selected.length < GITHUB_BATCH_LIMIT
          ? [...selected, item]
          : selected,
    );
  }
  function page(delta: number) {
    restoreScroll = 0;
    setView('query', 'page', (value) => value + delta);
  }
  function refresh() {
    restoreScroll = listRef?.scrollTop ?? 0;
    setRevision((v) => v + 1);
  }
  // Stable child objects: ResizablePanel keeps a child mounted while it stays in the list.
  const splitPanes: PanelChild[] = [
    {
      id: 'list',
      minSize: 220,
      defaultSize: 400,
      resizeLabel: 'Resize issue list',
      content: () => (
        <GitHubIssueListPane
          projectId={props.project.id}
          view={view}
          setView={setView}
          shownList={shownList()}
          loading={loading()}
          error={error()}
          refresh={refresh}
          page={page}
          toggleSelected={toggleSelected}
          listRef={(element) => (listRef = element)}
          onScroll={(scrollTop) => (restoreScroll = scrollTop)}
        />
      ),
    },
    {
      id: 'detail',
      minSize: 260,
      content: () => (
        <GitHubIssueDetailPane
          projectId={props.project.id}
          selectedUrl={view.selectedUrl}
          refresh={refresh}
        />
      ),
    },
  ];
  return (
    <section
      class="github-issues"
      aria-labelledby="github-issues-title"
      inert={props.covered || undefined}
    >
      <header class="github-issues-heading">
        <div>
          <h2 id="github-issues-title">
            GitHub <span>· {props.project.name}</span>
          </h2>
          <small>{view.result?.repository ?? 'GitHub'}</small>
        </div>
        <div class="github-issues-actions">
          <button type="button" disabled={loading()} onClick={refresh}>
            <SyncIcon /> Refresh
          </button>
          <button
            type="button"
            ref={props.toggleRef}
            aria-pressed={props.agentPane.open()}
            title="Show or hide the agent panel"
            onClick={() => props.agentPane.setOpen(!props.agentPane.open())}
          >
            <SparkleIcon /> Agent
          </button>
          <button type="button" onClick={() => openGitHubIssues(null)}>
            <ArrowLeftIcon /> Back to tasks
          </button>
        </div>
      </header>
      <Show when={shown()?.repository ?? view.result?.repository} keyed>
        {(repository) => (
          <GitHubListPicker projectId={props.project.id} repository={repository} shown={shown()} />
        )}
      </Show>
      <Show when={!shownList()}>
        <GitHubIssueFilters view={view} filters={filters} />
        <GitHubBatchBar
          project={props.project}
          agentPane={props.agentPane}
          view={view}
          setView={setView}
          loading={loading()}
          error={error()}
          toggleSelected={toggleSelected}
        />
      </Show>
      <ResizablePanel
        direction="horizontal"
        persistKey="github-split"
        class="github-issues-content"
        absorberIds={['detail']}
        children={splitPanes}
      />
    </section>
  );
}
