import { Show, createSignal } from 'solid-js';
import { theme } from '../lib/theme';
import { overlapText } from '../lib/readiness-line';
import type { Task } from '../store/types';
import type { BaseSync, MergeState } from './merge-state';
import { ModelMenu } from './ModelMenu';
import { GitBranchIcon, GitMergeIcon } from './icons';

type UpdateRoute = BaseSync | 'agent';

const routeTitle = (route: UpdateRoute, base: string) =>
  route === 'rebase'
    ? `Replay this branch's commits on top of ${base}`
    : route === 'merge'
      ? `Add a merge commit that brings ${base} into this branch; history stays as it is`
      : 'Close the dialog and ask the agent to rebase';

/**
 * Base moved on without conflicts: one quiet line with a single "Update branch"
 * action, its route (rebase, merge commit, agent) picked from the chevron.
 */
export function BaseSyncLine(props: {
  task: Task;
  state: MergeState;
  aheadCount: number;
  agentRunning: boolean;
  onAskAgent: () => void;
}) {
  const base = () => props.state.baseBranchName();
  const [picked, setPicked] = createSignal<UpdateRoute>();
  // Rebasing a branch behind a PR would need a force-push, so a PR defaults to a merge commit.
  const route = (): UpdateRoute => {
    const choice = picked();
    // A picked agent that stopped falls back to the default, not to a bare rebase.
    if (choice && !(choice === 'agent' && !props.agentRunning)) return choice;
    return props.task.prUrl ? 'merge' : 'rebase';
  };
  // Undefined when unknown: then neither the "no overlap" note nor the overlap line shows.
  const overlapping = () => props.state.mergeStatus()?.overlapping_files;
  const busy = () => props.state.syncing() !== null;
  const run = () => {
    const r = route();
    if (r === 'agent') props.onAskAgent();
    else void props.state.syncWithBase(r);
  };
  const label = () =>
    props.state.syncing() === 'rebase'
      ? 'Rebasing…'
      : props.state.syncing() === 'merge'
        ? 'Merging…'
        : 'Update branch';

  return (
    <div style={{ 'margin-bottom': '12px', 'font-size': '13px' }}>
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          gap: '12px',
        }}
      >
        <div>
          {base()} has {props.aheadCount} new commit{props.aheadCount > 1 ? 's' : ''}
          <Show when={overlapping()?.length === 0}>
            <span style={{ color: theme.fgMuted }}> · no overlap</span>
          </Show>
        </div>
        <div
          role="group"
          aria-label="Update branch"
          style={{
            display: 'inline-flex',
            'flex-shrink': '0',
            border: `1px solid ${theme.border}`,
            'border-radius': 'var(--radius-md)',
            overflow: 'hidden',
            background: theme.bgInput,
          }}
        >
          <button
            class="btn-with-icon"
            type="button"
            disabled={busy()}
            onClick={run}
            // The route lives in the menu; name it so assistive tech hears what a click does.
            aria-label={`${label()}: ${route() === 'agent' ? 'rebase with AI' : route() === 'merge' ? 'merge commit' : 'rebase'}`}
            title={routeTitle(route(), base())}
            // Full-strength text, no fill: a routine action (see AGENTS.md UI design).
            style={{
              padding: '3px 10px',
              border: '0',
              background: 'transparent',
              color: theme.fg,
              'font-size': '12px',
              'font-weight': '500',
              'white-space': 'nowrap',
              cursor: busy() ? 'not-allowed' : 'pointer',
              opacity: busy() ? '0.5' : '1',
            }}
          >
            <Show when={route() === 'merge'} fallback={<GitBranchIcon size={12} />}>
              <GitMergeIcon size={12} />
            </Show>
            {label()}
          </button>
          <ModelMenu
            label="Update branch by"
            class="change-tour-model"
            disabled={busy()}
            value={route()}
            onSelect={(value) => setPicked(value as UpdateRoute)}
            groups={[
              {
                heading: 'Update by',
                choices: [
                  { value: 'rebase', label: 'Rebase', title: routeTitle('rebase', base()) },
                  { value: 'merge', label: 'Merge commit', title: routeTitle('merge', base()) },
                  {
                    value: 'agent',
                    label: 'Rebase with AI',
                    title: routeTitle('agent', base()),
                    disabledReason: props.agentRunning ? undefined : 'The agent is not running',
                  },
                ],
              },
            ]}
          />
        </div>
      </div>
      {/* Checks on this branch never saw those commits; overlap is where that matters. */}
      <Show when={overlapping()?.length}>
        <div style={{ 'margin-top': '4px', color: theme.fgMuted }}>
          {overlapText(overlapping() ?? [], props.aheadCount)}
        </div>
      </Show>
      <Show when={props.state.syncError()}>
        <div style={{ 'margin-top': '6px', color: theme.error }}>{props.state.syncError()}</div>
      </Show>
    </div>
  );
}
