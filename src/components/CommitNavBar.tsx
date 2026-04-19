import { Show, createMemo } from 'solid-js';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import type { CommitInfo } from '../ipc/types';

interface CommitNavBarProps {
  commits: CommitInfo[];
  selectedCommitHash: string | null;
  onNavigate: (hash: string | null) => void;
  compact?: boolean;
  showMessage?: boolean;
}

export function CommitNavBar(props: CommitNavBarProps) {
  const currentIndex = createMemo(() => {
    const hash = props.selectedCommitHash;
    if (hash === null) return -1;
    return props.commits.findIndex((c) => c.hash === hash);
  });

  const isAllChanges = () => props.selectedCommitHash === null;
  const hasCommits = () => props.commits.length > 0;
  const canGoLeft = () => hasCommits() && (isAllChanges() || currentIndex() > 0);
  const canGoRight = () => !isAllChanges();

  const selectedCommit = createMemo(() => {
    const idx = currentIndex();
    return idx >= 0 ? props.commits[idx] : null;
  });

  function goLeft() {
    const commits = props.commits;
    if (commits.length === 0) return;
    if (isAllChanges()) {
      props.onNavigate(commits[commits.length - 1].hash);
    } else {
      const idx = currentIndex();
      if (idx > 0) {
        props.onNavigate(commits[idx - 1].hash);
      }
    }
  }

  function goRight() {
    const commits = props.commits;
    if (commits.length === 0 || isAllChanges()) return;
    const idx = currentIndex();
    if (idx < commits.length - 1) {
      props.onNavigate(commits[idx + 1].hash);
    } else {
      props.onNavigate(null);
    }
  }

  const compact = () => props.compact ?? false;
  const btnSize = () => (compact() ? '18px' : '22px');
  const iconSize = () => (compact() ? 12 : 14);

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
        title="Previous commit"
        style={{
          background: 'transparent',
          border: `1px solid ${theme.border}`,
          color: theme.fgMuted,
          cursor: canGoLeft() ? 'pointer' : 'not-allowed',
          opacity: canGoLeft() ? '1' : '0.5',
          'border-radius': '4px',
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
        title="Next commit"
        style={{
          background: 'transparent',
          border: `1px solid ${theme.border}`,
          color: theme.fgMuted,
          cursor: canGoRight() ? 'pointer' : 'not-allowed',
          opacity: canGoRight() ? '1' : '0.5',
          'border-radius': '4px',
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

      {/* All Changes button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          props.onNavigate(null);
        }}
        title="All changes (including uncommitted)"
        style={{
          background: isAllChanges()
            ? `color-mix(in srgb, ${theme.accent} 15%, transparent)`
            : 'transparent',
          border: `1px solid ${isAllChanges() ? theme.accent : theme.border}`,
          color: isAllChanges() ? theme.accent : theme.fgMuted,
          cursor: 'pointer',
          'border-radius': '4px',
          padding: compact() ? '1px 4px' : '2px 8px',
          'font-size': sf(compact() ? 10 : 12),
          'font-family': "'JetBrains Mono', monospace",
          'font-weight': isAllChanges() ? '600' : '400',
          'line-height': '1',
          'flex-shrink': '0',
          display: 'inline-flex',
          'align-items': 'center',
          height: btnSize(),
        }}
      >
        All
      </button>

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
