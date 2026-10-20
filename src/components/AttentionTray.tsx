import { matchesTaskProjectFilter } from '../store/task-project-filter';
import { createMemo, createSignal, For, Show } from 'solid-js';
import { store } from '../store/core';
import { setSidebarNeedsInputFirst } from '../store/ui';
import {
  computeAttentionEntries,
  jumpToWaitingTask,
  type AttentionEntry,
} from '../store/sidebar-attention';
import { getTaskAttentionState, getTaskDotStatus } from '../store/taskStatus';
import { formatRelativeAge } from '../lib/relativeAge';
import { sf } from '../lib/fontScale';
import { theme } from '../lib/theme';
import { DelegationReviewDialog } from './DelegationReviewDialog';
import { IconButton } from './IconButton';
import { ProjectSwatch } from './ProjectSwatch';
import { StatusDot } from './StatusDot';

/**
 * A self-landed result opens independently of task panels, including collapsed
 * tasks. Unmerged children open their task, where Finish reviews and merges them.
 */
function opensReview(entry: AttentionEntry): boolean {
  return (
    entry.kind === 'review' && store.tasks[entry.taskId]?.landingState === 'landed_pending_review'
  );
}

function AttentionRow(props: { entry: AttentionEntry; nowMs: number; onOpen: () => void }) {
  const task = () => store.tasks[props.entry.taskId];
  const project = () => store.projects.find((p) => p.id === task()?.projectId);
  const resume = () => task()?.collapsed && !opensReview(props.entry);
  return (
    <Show when={task()}>
      {(t) => (
        <button
          type="button"
          class="task-item sidebar-attention-row"
          aria-current={store.activeTaskId === props.entry.taskId ? 'true' : undefined}
          data-attention={getTaskAttentionState(props.entry.taskId)}
          title={[t().name, props.entry.label, props.entry.detail].filter(Boolean).join(' — ')}
          onClick={() => props.onOpen()}
          style={{
            display: 'flex',
            'flex-direction': 'column',
            'flex-shrink': '0',
            gap: '2px',
            padding: '6px 8px',
            'border-radius': 'var(--radius-sm)',
            'font-size': sf(12),
            color: theme.fg,
            'font-weight': '500',
            cursor: 'pointer',
            background: 'transparent',
            'text-align': 'left',
            width: '100%',
          }}
        >
          <div class="task-item-head">
            <StatusDot
              status={getTaskDotStatus(t().id)}
              taskId={t().id}
              size="sm"
              attention={getTaskAttentionState(t().id)}
            />
            <span class="task-item-name">{t().name}</span>
          </div>
          <span style={{ 'font-size': sf(11), color: theme.warning }}>
            {props.entry.label}
            <Show when={props.entry.kind === 'question' && props.entry.detail}>
              {' '}
              · {props.entry.detail}
            </Show>
          </span>
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '5px',
              'font-size': sf(11),
              color: theme.fgSubtle,
              'min-width': '0',
              width: '100%',
            }}
          >
            <Show when={project()}>
              {(p) => (
                <>
                  <ProjectSwatch color={p().color} size={6} />
                  <span
                    style={{
                      overflow: 'hidden',
                      'text-overflow': 'ellipsis',
                      'white-space': 'nowrap',
                    }}
                  >
                    {p().name}
                  </span>
                </>
              )}
            </Show>
            <Show when={props.entry.since !== undefined}>
              <span style={{ 'flex-shrink': '0' }}>
                {formatRelativeAge(props.entry.since ?? props.nowMs, props.nowMs)}
              </span>
            </Show>
          </div>
          <Show when={resume()}>
            <span style={{ 'font-size': sf(11) }}>Resume and open</span>
          </Show>
        </button>
      )}
    </Show>
  );
}

export function AttentionTray(props: { nowMs: number }) {
  const entries = createMemo(() =>
    computeAttentionEntries().filter((entry) => matchesTaskProjectFilter(entry.taskId)),
  );
  const [reviewTaskId, setReviewTaskId] = createSignal<string>();
  const reviewTask = () => {
    const id = reviewTaskId();
    return id ? store.tasks[id] : undefined;
  };
  function open(entry: AttentionEntry) {
    // A removed/resolved action must not revive a task from a stale click.
    if (!entries().some((current) => current.key === entry.key)) return;
    if (opensReview(entry)) setReviewTaskId(entry.taskId);
    else jumpToWaitingTask(entry.taskId, entry.panel);
  }
  return (
    <>
      <Show when={store.sidebarNeedsInputFirst && entries().length > 0}>
        <section class="sidebar-attention-tray" aria-label="Needs attention">
          <div class="sidebar-attention-tray-header">
            <span style={{ 'font-size': sf(12), color: theme.warning, 'font-weight': '600' }}>
              Needs attention ({entries().length})
            </span>
            <IconButton
              icon={<span aria-hidden="true">×</span>}
              onClick={() => setSidebarNeedsInputFirst(false)}
              title="Stop pinning actions that need attention (re-enable in Settings)"
              size="sm"
            />
          </div>
          <For each={entries().map((entry) => entry.key)}>
            {(key) => (
              <Show when={entries().find((entry) => entry.key === key)}>
                {(entry) => (
                  <AttentionRow entry={entry()} nowMs={props.nowMs} onOpen={() => open(entry())} />
                )}
              </Show>
            )}
          </For>
        </section>
      </Show>
      <Show when={reviewTask()}>
        {(task) => (
          <DelegationReviewDialog
            task={task()}
            open={true}
            onClose={() => setReviewTaskId(undefined)}
          />
        )}
      </Show>
    </>
  );
}
