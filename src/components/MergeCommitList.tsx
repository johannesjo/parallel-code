import { For, Show } from 'solid-js';
import { theme } from '../lib/theme';
import type { MergeState } from './merge-state';

export function MergeCommitList(props: { state: MergeState }) {
  return (
    <Show when={!props.state.branchLog.loading && props.state.branchLog()}>
      {(log) => {
        const commits = () =>
          log()
            .split('\n')
            .filter((l: string) => l.trim())
            .map((l: string) => {
              const stripped = l.replace(/^- /, '');
              const spaceIdx = stripped.indexOf(' ');
              if (spaceIdx > 0) {
                return {
                  hash: stripped.slice(0, spaceIdx),
                  msg: stripped.slice(spaceIdx + 1),
                };
              }
              return { hash: '', msg: stripped };
            });
        return (
          <div
            style={{
              'margin-bottom': '12px',
              'max-height': '120px',
              'overflow-y': 'auto',
              'overflow-x': 'hidden',
              'font-family': "'JetBrains Mono', monospace",
              'font-size': '12px',
              border: `1px solid ${theme.border}`,
              'border-radius': 'var(--radius-md)',
              padding: '4px 0',
            }}
          >
            <For each={commits()}>
              {(commit) => (
                <div
                  title={`${commit.hash} ${commit.msg}`}
                  style={{
                    display: 'flex',
                    'align-items': 'center',
                    gap: '6px',
                    padding: '2px 8px',
                    'white-space': 'nowrap',
                    overflow: 'hidden',
                    'text-overflow': 'ellipsis',
                    color: theme.fg,
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" style={{ 'flex-shrink': '0' }}>
                    <circle
                      cx="5"
                      cy="5"
                      r="3"
                      fill="none"
                      stroke={theme.accent}
                      stroke-width="1.5"
                    />
                  </svg>
                  <Show when={commit.hash}>
                    <span style={{ color: theme.fgMuted, 'flex-shrink': '0' }}>{commit.hash}</span>
                  </Show>
                  <span
                    style={{
                      overflow: 'hidden',
                      'text-overflow': 'ellipsis',
                    }}
                  >
                    {commit.msg}
                  </span>
                </div>
              )}
            </For>
          </div>
        );
      }}
    </Show>
  );
}
