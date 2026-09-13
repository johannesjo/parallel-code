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
import { projectInitials } from '../lib/project-initials';
import type { Task } from '../store/types';
import {
  AlertIcon,
  CheckIcon,
  FolderIcon,
  GitHubIcon,
  GitBranchIcon,
  PencilIcon,
  PersonIcon,
} from './icons';

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
  const project = () => getProject(props.task.projectId);
  // The project's colour rides the bar's left edge instead of an inline dot, so
  // it reads on a different axis than the status circle stacked above it.
  const projectStripe = () => {
    const color = project()?.color;
    return color ? { 'border-left': `3px solid ${color}` } : undefined;
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
    <InfoBar class="task-branch-info-bar" style={projectStripe()}>
      <Show when={project()}>
        {(p) => (
          <button
            type="button"
            class="task-branch-info-button task-branch-project"
            onClick={() => props.onEditProject(p().id)}
            title={`${p().name} · Project settings`}
            aria-label={`Project: ${p().name} · Project settings`}
            style={{ ...infoBarBtnStyle, margin: '0 8px 0 0' }}
          >
            <span class="task-branch-project-label">{p().name}</span>
            <span class="task-branch-project-compact-label" aria-hidden="true">
              {projectInitials(p().name)}
            </span>
          </button>
        )}
      </Show>
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
            <GitHubIcon size={12} style={{ 'flex-shrink': '0' }} />
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
        style={{ ...infoBarBtnStyle, opacity: 0.6, 'min-width': '0', overflow: 'hidden' }}
      >
        <FolderIcon size={12} style={{ 'flex-shrink': '0' }} />
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
