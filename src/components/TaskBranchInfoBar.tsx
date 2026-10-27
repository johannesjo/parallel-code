import { For, Show, createMemo, createSignal, type JSX } from 'solid-js';
import { errMessage } from '../lib/log';
import {
  store,
  getProject,
  showNotification,
  getPrChecks,
  getBranchDivergence,
} from '../store/store';
import { stageFailedChecksPrompt } from '../store/github';
import { sameDivergence } from '../lib/branch-divergence';
import { badgeStyle, rowChipBox } from '../lib/badgeStyle';
import { revealItemInDir, openInEditor } from '../lib/shell';
import { InfoBar } from './InfoBar';
import { ProjectSwatch } from './ProjectSwatch';
import { theme } from '../lib/theme';
import { isMac } from '../lib/platform';
import { parseGitHubUrl } from '../lib/github-url';
import { abbreviateHomePath } from '../lib/path';
import { projectInitials } from '../lib/project-initials';
import type { Task } from '../store/types';
import { FolderIcon, GitBranchIcon, GitMergeIcon, GitHubMarkIcon, ToolsIcon } from './icons';
import { PrChip } from './PrChip';
import { menuPointFor, ProjectMenu } from './project-menu';
import { RemoveProjectConfirm } from './RemoveProjectConfirm';
import { codeProjects } from '../store/projects';
import { BabysitButton } from './BabysitButton';
import { extraPrWatchId, getTaskExtraPrs, isPrReadyToMerge } from '../store/pr-checks-state';

const infoBarBtnStyle: JSX.CSSProperties = {
  'align-self': 'stretch',
  background: 'transparent',
  border: 'none',
  padding: '0 4px',
  color: 'inherit',
  cursor: 'pointer',
  'font-family': 'inherit',
  'font-size': 'inherit',
};

const prChipStyle: JSX.CSSProperties = {
  ...infoBarBtnStyle,
  'margin-right': '8px',
  color: theme.accent,
};

const warningChipStyle: JSX.CSSProperties = {
  ...badgeStyle(theme.warning),
  ...rowChipBox,
};

/** Red because a failed PR check is the kind of urgency the fill is reserved for. */
const fixCiBtnStyle: JSX.CSSProperties = {
  background: theme.error,
  color: '#fff',
  border: 'none',
  'border-radius': 'var(--radius-xs)',
  ...rowChipBox,
  'margin-right': '8px',
  'font-family': 'inherit',
  'font-weight': '600',
  cursor: 'pointer',
  'white-space': 'nowrap',
  'flex-shrink': '0',
  gap: '4px',
};

/** Stages the failed checks and their log tails as a prompt in the task input. */
function FixCiButton(props: { taskId: string; prUrl: string; prNumber: number; repo?: string }) {
  const [busy, setBusy] = createSignal(false);
  const fix = async () => {
    setBusy(true);
    try {
      const staged = await stageFailedChecksPrompt(props.taskId, {
        number: props.prNumber,
        url: props.prUrl,
        repo: props.repo,
      });
      showNotification(
        staged
          ? 'Prompt staged in the task input. Review it, then send.'
          : 'No failed checks found.',
      );
    } catch (err) {
      showNotification(`Could not collect failed checks: ${errMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      class="task-pr-fix-ci"
      disabled={busy()}
      aria-busy={busy()}
      onClick={() => void fix()}
      title="Collect failed checks and their log tails into a prompt for the agent"
      style={{ ...fixCiBtnStyle, opacity: busy() ? '0.7' : '1' }}
    >
      <ToolsIcon size={12} />
      {busy() ? 'Collecting…' : 'Fix CI'}
    </button>
  );
}

interface TaskBranchInfoBarProps {
  task: Task;
  onEditProject: (projectId: string) => void;
  /** Opens the in-app PR panel; without it the PR chip opens GitHub. */
  onOpenPullRequest?: (prUrl: string) => void;
  /** Opens the finish dialog; without it there is no Merge shortcut. */
  onFinish?: () => void;
  /** Attention items placed right after the project, ahead of the PR and branch. */
  afterProject?: JSX.Element;
  /** Routine items closing the row; the first to be cut when the column is narrow. */
  trailing?: JSX.Element;
}

export function TaskBranchInfoBar(props: TaskBranchInfoBarProps) {
  const project = () => getProject(props.task.projectId);
  const [projectMenuAt, setProjectMenuAt] = createSignal<{ x: number; y: number } | null>(null);
  const [confirmRemove, setConfirmRemove] = createSignal<string | null>(null);
  // Keep project color separate from the status indicators above the bar. A
  // project icon carries the color itself, so it replaces the stripe.
  const projectStripe = () => {
    const p = project();
    return p?.color && !p.icon ? { 'border-left': `3px solid ${p.color}` } : undefined;
  };
  const mod = isMac ? 'Cmd' : 'Ctrl';
  const isPrUrl = (url: string | undefined): boolean => {
    const parsed = url ? parseGitHubUrl(url) : null;
    return parsed?.type === 'pull' && !!parsed.number;
  };
  const githubLabel = (url: string): string => url.replace(/^https?:\/\/(www\.)?github\.com\//, '');
  const compactSourceLabel = (url: string): string => {
    const parsed = parseGitHubUrl(url);
    return parsed?.number ? `#${parsed.number}` : (parsed?.repo ?? 'Source');
  };
  const prLinkUrl = () =>
    props.task.prUrl ?? (isPrUrl(props.task.githubUrl) ? props.task.githubUrl : undefined);
  const prNumber = () => {
    const url = prLinkUrl();
    const parsed = url ? parseGitHubUrl(url) : null;
    return parsed?.type === 'pull' ? parsed.number : undefined;
  };
  const sourceLinkUrl = () => {
    const prUrl = prLinkUrl();
    return props.task.githubUrl && props.task.githubUrl !== prUrl
      ? props.task.githubUrl
      : undefined;
  };
  const editorTitle = () =>
    store.editorCommand
      ? `Click to open in ${store.editorCommand} · ${mod}+Click to reveal in file manager · ${mod}+Shift+Click to open the project root in ${store.editorCommand}`
      : `Click to reveal in file manager · ${mod}+Shift+Click to reveal the project root`;
  const worktreeTitle = () => `${props.task.worktreePath}\n${editorTitle()}`;

  // Confirmed divergence between the branch the task tracks and the branch
  // the agent actually put the worktree on (tracked store-side from the
  // git-status poll). The equals guard stops per-poll re-renders while a
  // divergence chip is visible.
  const confirmedDivergence = createMemo(() => getBranchDivergence(props.task.id), null, {
    equals: sameDivergence,
  });
  // Adoptable divergence never renders here: the store auto-adopts it as soon
  // as it is confirmed, and the task banner takes over. Only the non-adoptable
  // cases (worktree on the base branch, or on a name the IPC layer rejects)
  // warn.
  const nonAdoptableDivergence = () => {
    const d = confirmedDivergence();
    return d?.kind === 'switched' && !d.adoptable ? d : null;
  };
  const isDetached = () => confirmedDivergence()?.kind === 'detached';

  const handleOpenInEditor = (e: MouseEvent) => {
    const modKey = e.ctrlKey || e.metaKey;
    if (modKey && e.shiftKey) {
      const projectPath = getProject(props.task.projectId)?.path;
      if (!projectPath) return;
      const action = store.editorCommand
        ? openInEditor(store.editorCommand, projectPath)
        : revealItemInDir(projectPath);
      action.catch((err) => showNotification(`Could not open project folder: ${errMessage(err)}`));
      return;
    }
    if (store.editorCommand && !modKey) {
      openInEditor(store.editorCommand, props.task.worktreePath).catch((err) =>
        showNotification(`Editor failed: ${err instanceof Error ? err.message : 'unknown error'}`),
      );
    } else {
      revealItemInDir(props.task.worktreePath).catch((err) =>
        showNotification(`Could not open folder: ${errMessage(err)}`),
      );
    }
  };

  return (
    <InfoBar
      class={`task-branch-info-bar${codeProjects().length === 1 ? ' task-branch-info-bar--single-project' : ''}`}
      style={projectStripe()}
    >
      <Show when={project()}>
        {(p) => (
          <>
            <button
              type="button"
              class="task-branch-info-button task-branch-project"
              onClick={(e) => setProjectMenuAt(menuPointFor(e, e.currentTarget))}
              onContextMenu={(e) => {
                e.preventDefault();
                setProjectMenuAt(menuPointFor(e, e.currentTarget));
              }}
              aria-haspopup="menu"
              aria-expanded={projectMenuAt() !== null}
              title={`${p().name} · Project actions`}
              aria-label={`Project: ${p().name} · Project actions`}
              style={{ ...infoBarBtnStyle, margin: '0 8px 0 0' }}
            >
              <Show when={p().icon}>
                {(icon) => <ProjectSwatch color={p().color} icon={icon()} size={8} />}
              </Show>
              <span class="task-branch-project-label">{p().name}</span>
              <span class="task-branch-project-compact-label" aria-hidden="true">
                {projectInitials(p().name)}
              </span>
            </button>
            <Show when={projectMenuAt()}>
              {(at) => (
                <ProjectMenu
                  project={p()}
                  at={at()}
                  dialogs={{
                    editSettings: (edited) => props.onEditProject(edited.id),
                    remove: setConfirmRemove,
                  }}
                  onClose={() => setProjectMenuAt(null)}
                />
              )}
            </Show>
          </>
        )}
      </Show>
      <RemoveProjectConfirm projectId={confirmRemove()} onDone={() => setConfirmRemove(null)} />
      {props.afterProject}
      <Show when={prLinkUrl()}>
        {(url) => {
          const pr = () => getPrChecks(props.task.id);
          const ciFailed = () => pr()?.overall === 'failure' && !pr()?.merged;
          // Hide Merge when the PR state already rules a merge out; the finish dialog
          // still decides the route (GitHub or local) and any remaining protection.
          const readyToMerge = () => isPrReadyToMerge(pr());
          return (
            <>
              <PrChip
                url={url()}
                checks={pr()}
                style={prChipStyle}
                onOpenPullRequest={props.onOpenPullRequest}
              />
              <Show when={ciFailed() && prNumber()}>
                {(number) => (
                  <FixCiButton taskId={props.task.id} prUrl={url()} prNumber={Number(number())} />
                )}
              </Show>
              <Show when={pr() && !pr()?.merged}>
                <BabysitButton taskId={props.task.id} />
              </Show>
              <Show when={readyToMerge() && props.onFinish}>
                {(finish) => (
                  <button
                    type="button"
                    class="task-pr-merge"
                    onClick={() => finish()()}
                    title="CI passed — open Finish to merge"
                  >
                    <GitMergeIcon size={12} />
                    Merge
                  </button>
                )}
              </Show>
            </>
          );
        }}
      </Show>
      <For each={getTaskExtraPrs(props.task.id)}>
        {(extra) => {
          // The in-app PR panel and Merge belong to the task's own PR, so an
          // additional PR opens on GitHub and only offers Fix CI.
          const checks = () => getPrChecks(extraPrWatchId(props.task.id, extra.url));
          const prNumber = () => parseGitHubUrl(extra.url)?.number;
          const ciFailed = () => checks()?.overall === 'failure' && !checks()?.merged;
          return (
            <>
              <PrChip url={extra.url} repo={extra.repo} checks={checks()} style={prChipStyle} />
              <Show when={ciFailed() && prNumber()}>
                {(number) => (
                  <FixCiButton
                    taskId={props.task.id}
                    prUrl={extra.url}
                    prNumber={Number(number())}
                    repo={extra.repo}
                  />
                )}
              </Show>
            </>
          );
        }}
      </For>
      <Show when={sourceLinkUrl()}>
        {(url) => (
          <button
            type="button"
            class="task-branch-info-button task-branch-source"
            onClick={() => window.open(url(), '_blank')}
            title={url()}
            aria-label={`Source: ${githubLabel(url())}`}
            style={{ ...infoBarBtnStyle, 'margin-right': '8px' }}
          >
            <span
              class="task-branch-source-prefix"
              style={{ color: theme.fgMuted, 'font-weight': '600' }}
            >
              Source
            </span>
            <GitHubMarkIcon size={12} style={{ 'flex-shrink': '0' }} />
            <span class="task-branch-source-label">{githubLabel(url())}</span>
            <span class="task-branch-source-compact-label">{compactSourceLabel(url())}</span>
          </button>
        )}
      </Show>
      <Show when={props.task.gitIsolation !== 'none'}>
        <button
          type="button"
          class="task-branch-info-button task-branch-name"
          title={editorTitle()}
          onClick={handleOpenInEditor}
          style={{ ...infoBarBtnStyle, 'margin-right': '12px' }}
        >
          <GitBranchIcon size={12} style={{ 'flex-shrink': '0' }} />
          <Show when={props.task.gitIsolation !== 'direct'}>
            <span class="task-branch-name-label">{props.task.branchName}</span>
          </Show>
          <Show when={props.task.gitIsolation === 'direct'}>
            <span class="task-branch-name-label" style={warningChipStyle}>
              {props.task.branchName}
            </span>
          </Show>
        </button>
      </Show>
      <Show when={isDetached()}>
        <span
          class="task-branch-divergence"
          title={`The worktree is not on any branch (detached HEAD). Merging is blocked until it is back on '${props.task.branchName}'.`}
          style={{ ...warningChipStyle, 'margin-right': '12px' }}
        >
          detached HEAD
        </span>
      </Show>
      <Show when={nonAdoptableDivergence()}>
        {(d) => (
          <span
            class="task-branch-divergence"
            title={
              d().branch === props.task.baseBranch
                ? `The worktree is on the base branch '${d().branch}' but this task tracks '${props.task.branchName}'. Ask the agent to switch back.`
                : `The worktree is on '${d().branch}', which this task cannot adopt, but it tracks '${props.task.branchName}'. Ask the agent to switch back.`
            }
            style={{ ...warningChipStyle, 'margin-right': '12px' }}
          >
            → {d().branch}
          </span>
        )}
      </Show>
      <button
        type="button"
        class="task-branch-info-button task-branch-path"
        title={worktreeTitle()}
        onClick={handleOpenInEditor}
        // The branch already names the worktree; the full path is in the tooltip.
        aria-label={`Worktree folder: ${abbreviateHomePath(props.task.worktreePath)}`}
        style={{ ...infoBarBtnStyle, opacity: 0.6 }}
      >
        <FolderIcon size={12} style={{ 'flex-shrink': '0' }} />
      </button>
      <Show when={props.task.externalWorktree}>
        <span
          class="task-branch-existing-worktree"
          style={{
            'align-items': 'center',
            gap: '4px',
            color: theme.accent,
          }}
        >
          Existing worktree
        </span>
      </Show>
      {props.trailing}
    </InfoBar>
  );
}
