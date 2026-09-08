import { Match, Show, Switch, createMemo, type JSX } from 'solid-js';
import { errMessage } from '../lib/log';
import {
  store,
  getProject,
  showNotification,
  getPrChecks,
  getBranchDivergence,
} from '../store/store';
import { sameDivergence } from '../lib/branch-divergence';
import { badgeStyle } from '../lib/badgeStyle';
import { revealItemInDir, openInEditor } from '../lib/shell';
import { InfoBar } from './InfoBar';
import { theme } from '../lib/theme';
import { isMac } from '../lib/platform';
import { parseGitHubUrl } from '../lib/github-url';
import { abbreviateHomePath } from '../lib/path';
import type { Task } from '../store/types';
import { AlertIcon, CheckIcon, PencilIcon, PersonIcon } from './icons';

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

const warningChipStyle: JSX.CSSProperties = {
  ...badgeStyle(theme.warning),
  'font-size': '11px',
  padding: '1px 6px',
};

type ReviewStatusKind = 'approved' | 'changes-requested' | 'review-needed' | 'draft';

interface ReviewStatus {
  kind: ReviewStatusKind;
  label: string;
  accessibleLabel: string;
  title: string;
  color: string;
}

function ReviewStatusIcon(props: { kind: ReviewStatusKind }) {
  return (
    <Switch>
      <Match when={props.kind === 'approved'}>
        <CheckIcon size={12} />
      </Match>
      <Match when={props.kind === 'changes-requested'}>
        <AlertIcon size={12} />
      </Match>
      <Match when={props.kind === 'review-needed'}>
        <PersonIcon size={12} />
      </Match>
      <Match when={props.kind === 'draft'}>
        <PencilIcon size={12} />
      </Match>
    </Switch>
  );
}

interface TaskBranchInfoBarProps {
  task: Task;
  onEditProject: (projectId: string) => void;
}

export function TaskBranchInfoBar(props: TaskBranchInfoBarProps) {
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
    <InfoBar class="task-branch-info-bar">
      {(() => {
        const project = getProject(props.task.projectId);
        return (
          <Show when={project}>
            {(p) => (
              <button
                type="button"
                class="task-branch-info-button task-branch-project"
                onClick={() => props.onEditProject(p().id)}
                title="Project settings"
                style={{ ...infoBarBtnStyle, margin: '0 8px 0 0' }}
              >
                <div
                  style={{
                    width: '7px',
                    height: '7px',
                    'border-radius': '50%',
                    background: p().color,
                    'flex-shrink': '0',
                  }}
                />
                <span class="task-branch-project-label">{p().name}</span>
              </button>
            )}
          </Show>
        );
      })()}
      <Show when={prLinkUrl()}>
        {(url) => {
          const pr = () => getPrChecks(props.task.id);
          const reviewStatus = (): ReviewStatus | null => {
            const c = pr();
            if (!c) return null;
            if (c.isDraft) {
              return {
                kind: 'draft',
                label: 'Draft',
                accessibleLabel: 'Draft',
                title: 'Draft pull request',
                color: theme.fgMuted,
              };
            }
            switch (c.reviewDecision) {
              case 'CHANGES_REQUESTED':
                return {
                  kind: 'changes-requested',
                  label: 'Changes',
                  accessibleLabel: 'Changes requested',
                  title: 'Review: changes requested',
                  color: theme.warning,
                };
              case 'APPROVED':
                return {
                  kind: 'approved',
                  label: 'Approved',
                  accessibleLabel: 'Approved',
                  title: 'Review: approved',
                  color: theme.success,
                };
              case 'REVIEW_REQUIRED':
                return {
                  kind: 'review-needed',
                  label: 'Review',
                  accessibleLabel: 'Review needed',
                  title: 'Review required',
                  color: theme.accent,
                };
              default:
                return null;
            }
          };
          const ciStatus = (): { label: string; title: string; color: string } | null => {
            const c = pr();
            if (!c || c.overall === 'none') return null;
            if (c.overall === 'pending') {
              return {
                label: 'CI running',
                title: `CI running — ${c.pending} pending, ${c.passing} passing${c.failing ? `, ${c.failing} failing` : ''}`,
                color: theme.warning,
              };
            }
            if (c.overall === 'success') {
              return {
                label: 'CI passed',
                title: `CI passed — ${c.passing} check${c.passing === 1 ? '' : 's'}`,
                color: theme.success,
              };
            }
            return {
              label: 'CI failed',
              title: `CI failed — ${c.failing} failing, ${c.passing} passing${c.pending ? `, ${c.pending} pending` : ''}`,
              color: theme.error,
            };
          };
          const buttonTitle = () =>
            [reviewStatus()?.title, ciStatus()?.title, url()].filter(Boolean).join('\n');
          const buttonLabel = () =>
            [`PR #${prNumber()}`, reviewStatus()?.accessibleLabel, ciStatus()?.label]
              .filter(Boolean)
              .join(', ');
          return (
            <button
              type="button"
              class="task-branch-info-button task-pr-link"
              onClick={() => window.open(url(), '_blank')}
              title={buttonTitle()}
              aria-label={buttonLabel()}
              style={{ ...infoBarBtnStyle, 'margin-right': '8px', color: theme.accent }}
            >
              <Show when={ciStatus()}>
                {(ci) => (
                  <span class="task-pr-ci-state">
                    <Show
                      when={pr()?.overall === 'pending'}
                      fallback={
                        <span
                          style={{
                            width: '7px',
                            height: '7px',
                            'border-radius': '50%',
                            background: ci().color,
                          }}
                        />
                      }
                    >
                      <span
                        class="inline-spinner"
                        style={{ width: '10px', height: '10px', color: ci().color }}
                      />
                    </Show>
                  </span>
                )}
              </Show>
              <span class="task-pr-label" style={{ color: theme.fgMuted, 'font-weight': '600' }}>
                <span class="task-pr-prefix">PR </span>
                <span class="task-pr-number">#{prNumber()}</span>
              </span>
              <Show when={reviewStatus()}>
                {(review) => (
                  <span class="task-pr-review-status" style={{ color: review().color }}>
                    <span class="task-pr-review-label">{review().label}</span>
                    <span class={`task-pr-review-icon task-pr-review-icon--${review().kind}`}>
                      <ReviewStatusIcon kind={review().kind} />
                    </span>
                  </span>
                )}
              </Show>
            </button>
          );
        }}
      </Show>
      <Show when={sourceLinkUrl()}>
        {(url) => (
          <button
            type="button"
            class="task-branch-info-button task-branch-source"
            onClick={() => window.open(url(), '_blank')}
            title={url()}
            aria-label={`Source: ${githubLabel(url())}`}
            style={{ ...infoBarBtnStyle, 'margin-right': '8px', color: theme.accent }}
          >
            <span
              class="task-branch-source-prefix"
              style={{ color: theme.fgMuted, 'font-weight': '600' }}
            >
              Source
            </span>
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="currentColor"
              style={{ 'flex-shrink': '0' }}
            >
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
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
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="currentColor"
            style={{ 'flex-shrink': '0' }}
          >
            <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm6.25 7.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 7.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 0h5.5a2.5 2.5 0 0 0 2.5-2.5v-.5a.75.75 0 0 0-1.5 0v.5a1 1 0 0 1-1 1H5a3.25 3.25 0 1 0 0 6.5h6.25a.75.75 0 0 0 0-1.5H5a1.75 1.75 0 1 1 0-3.5Z" />
          </svg>
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
        style={{ ...infoBarBtnStyle, opacity: 0.6, 'min-width': '0', overflow: 'hidden' }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="currentColor"
          style={{ 'flex-shrink': '0' }}
        >
          <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
        </svg>
        <span
          class="task-branch-path-label"
          style={{
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
            'white-space': 'nowrap',
            'min-width': '0',
          }}
        >
          {abbreviateHomePath(props.task.worktreePath)}
        </span>
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
    </InfoBar>
  );
}
