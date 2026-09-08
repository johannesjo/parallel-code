import { Show, createMemo } from 'solid-js';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { accentControlColors } from '../lib/controlStyle';
import type { CommitInfo } from '../ipc/types';

/**
 * Sentinel value used in place of a commit hash to mean "show only currently
 * uncommitted changes". Picked so it cannot collide with a hex commit hash
 * (the IPC validator rejects non-hex strings).
 */
export const UNCOMMITTED_SELECTION = 'uncommitted';

export type CommitSelection = string | null;

export function isUncommittedSelection(value: CommitSelection | undefined): boolean {
  return value === UNCOMMITTED_SELECTION;
}

export function isCommitHashSelection(value: CommitSelection | undefined): value is string {
  return value !== null && value !== undefined && value !== UNCOMMITTED_SELECTION;
}

interface CommitNavBarProps {
  commits: CommitInfo[];
  selectedCommitHash: CommitSelection;
  onNavigate: (selection: CommitSelection) => void;
  compact?: boolean;
  showMessage?: boolean;
}

export function CommitNavBar(props: CommitNavBarProps) {
  const currentIndex = createMemo(() => {
    const hash = props.selectedCommitHash;
    if (hash === null || hash === UNCOMMITTED_SELECTION) return -1;
    return props.commits.findIndex((c) => c.hash === hash);
  });

  const isAllChanges = () => props.selectedCommitHash === null;
  const isUncommittedOnly = () => props.selectedCommitHash === UNCOMMITTED_SELECTION;
  const hasCommits = () => props.commits.length > 0;
  // All → Uncommitted (always); Uncommitted → latest commit (needs commits);
  // commit N → commit N-1 (needs a previous commit).
  const canGoLeft = () =>
    isAllChanges() || (isUncommittedOnly() && hasCommits()) || (hasCommits() && currentIndex() > 0);
  const canGoRight = () => !isAllChanges();

  const selectedCommit = createMemo(() => {
    const idx = currentIndex();
    return idx >= 0 ? props.commits[idx] : null;
  });

  function goLeft() {
    if (isAllChanges()) {
      props.onNavigate(UNCOMMITTED_SELECTION);
      return;
    }
    if (isUncommittedOnly()) {
      const commits = props.commits;
      if (commits.length === 0) return;
      props.onNavigate(commits[commits.length - 1].hash);
      return;
    }
    const idx = currentIndex();
    if (idx > 0) {
      props.onNavigate(props.commits[idx - 1].hash);
    }
  }

  function goRight() {
    if (isAllChanges()) return;
    if (isUncommittedOnly()) {
      props.onNavigate(null);
      return;
    }
    const commits = props.commits;
    const idx = currentIndex();
    if (idx < commits.length - 1) {
      props.onNavigate(commits[idx + 1].hash);
    } else {
      props.onNavigate(UNCOMMITTED_SELECTION);
    }
  }

  const compact = () => props.compact ?? false;
  const btnSize = () => (compact() ? '18px' : '22px');
  const iconSize = () => (compact() ? 12 : 14);
  const pillPadding = () => (compact() ? '1px 4px' : '2px 8px');
  const pillFontSize = () => sf(compact() ? 10 : 12);

  function pillStyle(active: boolean) {
    return {
      ...accentControlColors(active),
      cursor: 'pointer',
      'border-radius': 'var(--radius-xs)',
      padding: pillPadding(),
      'font-size': pillFontSize(),
      'font-family': "'JetBrains Mono', monospace",
      'font-weight': active ? '600' : '400',
      'line-height': '1',
      'flex-shrink': '0',
      display: 'inline-flex',
      'align-items': 'center',
      height: btnSize(),
    } as const;
  }

  return (
    <div
      style={{
        display: 'flex',
        'align-items': 'center',
        gap: compact() ? '2px' : '4px',
        'flex-shrink': '0',
      }}
    >
      {/* Chevron Left */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          goLeft();
        }}
        disabled={!canGoLeft()}
        title="Previous"
        style={{
          background: 'transparent',
          border: `1px solid ${theme.border}`,
          color: theme.fgMuted,
          cursor: canGoLeft() ? 'pointer' : 'not-allowed',
          opacity: canGoLeft() ? '1' : '0.5',
          'border-radius': 'var(--radius-xs)',
          padding: '0',
          width: btnSize(),
          height: btnSize(),
          display: 'inline-flex',
          'align-items': 'center',
          'justify-content': 'center',
          'flex-shrink': '0',
        }}
      >
        <svg width={iconSize()} height={iconSize()} viewBox="0 0 16 16" fill="currentColor">
          <path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z" />
        </svg>
      </button>

      {/* Chevron Right */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          goRight();
        }}
        disabled={!canGoRight()}
        title="Next"
        style={{
          background: 'transparent',
          border: `1px solid ${theme.border}`,
          color: theme.fgMuted,
          cursor: canGoRight() ? 'pointer' : 'not-allowed',
          opacity: canGoRight() ? '1' : '0.5',
          'border-radius': 'var(--radius-xs)',
          padding: '0',
          width: btnSize(),
          height: btnSize(),
          display: 'inline-flex',
          'align-items': 'center',
          'justify-content': 'center',
          'flex-shrink': '0',
        }}
      >
        <svg width={iconSize()} height={iconSize()} viewBox="0 0 16 16" fill="currentColor">
          <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
        </svg>
      </button>

      {/* Uncommitted-only button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          props.onNavigate(UNCOMMITTED_SELECTION);
        }}
        title="Uncommitted changes only"
        style={pillStyle(isUncommittedOnly())}
      >
        U
      </button>

      {/* All Changes button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          props.onNavigate(null);
        }}
        title="All changes (including uncommitted)"
        style={pillStyle(isAllChanges())}
      >
        All
      </button>

      <Show when={props.showMessage && isUncommittedOnly()}>
        <span
          style={{
            'font-size': sf(12),
            'font-family': "'JetBrains Mono', monospace",
            color: theme.fgMuted,
            'white-space': 'nowrap',
            'flex-shrink': '0',
          }}
        >
          Uncommitted changes only
        </span>
      </Show>

      <Show when={props.showMessage && selectedCommit()}>
        {(commit) => (
          <span
            style={{
              'font-size': sf(12),
              'font-family': "'JetBrains Mono', monospace",
              color: theme.fgMuted,
              'white-space': 'nowrap',
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
              'min-width': '0',
              'max-width': '300px',
            }}
            title={`${commit().hash.slice(0, 7)} ${commit().message}`}
          >
            <span style={{ color: theme.accent, 'font-weight': '600' }}>
              {commit().hash.slice(0, 7)}
            </span>{' '}
            {commit().message}
          </span>
        )}
      </Show>
    </div>
  );
}
