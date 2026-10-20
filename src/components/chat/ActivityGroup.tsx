import { For, Match, Show, Switch, createEffect, createMemo, on } from 'solid-js';
import type { ChatItem } from '../../../electron/shared/agent-chat-types';
import { DiffStat, DiffView } from './DiffView';
import { ChevronRightIcon, DiffIcon } from '../icons';

const activityLabels = {
  running: 'Running',
  completed: 'Done',
  failed: 'Failed',
  declined: 'Declined',
  interrupted: 'Stopped',
};

const typeLabels = { command: 'Command', files: 'Changes', tool: 'Tool' };

export interface ActivityActions {
  onReview?: (path?: string) => void;
  onOpenFile?: (path: string) => void;
  /** Opens the tour the agent published; omitted when this run did not publish it. */
  onOpenTour?: () => void;
}

/** A command line above its output, as a terminal shows it. */
export function CommandOutput(props: { command: string; output: string; running: boolean }) {
  return (
    <pre class="chat-command">
      <span class="chat-command-line">$ {props.command}</span>
      {'\n'}
      {props.output || (props.running ? 'No output yet.' : 'No output.')}
    </pre>
  );
}

function ActivityRow(props: ActivityActions & { item: ChatItem }) {
  let details: HTMLDetailsElement | undefined;
  const activity = () => props.item.activity;
  const stats = createMemo(() => totalStats([props.item]));
  createEffect(() => {
    if (activity()?.status === 'failed' && details) details.open = true;
  });
  return (
    <div data-chat-id={props.item.id}>
      <details class="chat-tool" ref={details} data-status={activity()?.status}>
        <summary>
          <span class="chat-tool-type">{typeLabels[activity()?.type ?? 'tool']}</span>
          <span class="chat-tool-label" title={activity()?.label}>
            {activity()?.label || 'Tool activity'}
          </span>
          <Show when={stats()}>{(total) => <DiffStat {...total()} />}</Show>
          <span class="chat-tool-status">
            {activity() && activityLabels[activity()?.status ?? 'running']}
            {activity()?.exitCode !== undefined ? ` · exit ${activity()?.exitCode}` : ''}
          </span>
        </summary>
        <Switch
          fallback={
            <>
              <For each={activity()?.files}>
                {(path) => (
                  <div class="chat-file">
                    <button
                      onClick={() => props.onOpenFile?.(path)}
                      disabled={!props.onOpenFile}
                      title={path}
                    >
                      {path}
                    </button>
                    <Show when={activity()?.type === 'files' && props.onReview}>
                      <button class="btn-with-icon" onClick={() => props.onReview?.(path)}>
                        <DiffIcon size={12} />
                        Review diff
                      </button>
                    </Show>
                  </div>
                )}
              </For>
              <pre>{props.item.text || 'No output yet.'}</pre>
            </>
          }
        >
          <Match when={activity()?.command}>
            {(command) => (
              <CommandOutput
                command={command()}
                output={props.item.text}
                running={activity()?.status === 'running'}
              />
            )}
          </Match>
          <Match when={activity()?.diffs?.length}>
            <For each={activity()?.diffs}>
              {(diff) => (
                <DiffView
                  diff={diff}
                  applied={activity()?.status === 'completed'}
                  onReview={props.onReview}
                  onOpenFile={props.onOpenFile}
                />
              )}
            </For>
            <Show when={props.item.text}>
              <pre>{props.item.text}</pre>
            </Show>
          </Match>
        </Switch>
      </details>
    </div>
  );
}

/** Lines added and removed across the applied and running edits in `items`, if any. */
function totalStats(items: ChatItem[]) {
  const diffs = items.flatMap((item) =>
    item.activity?.status === 'completed' || item.activity?.status === 'running'
      ? (item.activity.diffs ?? [])
      : [],
  );
  if (!diffs.length) return undefined;
  return diffs.reduce(
    (total, diff) => ({ added: total.added + diff.added, removed: total.removed + diff.removed }),
    { added: 0, removed: 0 },
  );
}

/** One run of consecutive tool calls, folded into a summary line. */
export function ActivityGroup(props: ActivityActions & { items: ChatItem[] }) {
  let details: HTMLDetailsElement | undefined;
  const failures = createMemo(
    () =>
      new Set(
        props.items.filter((item) => item.activity?.status === 'failed').map((item) => item.id),
      ),
  );
  const declined = () => props.items.filter((item) => item.activity?.status === 'declined').length;
  const stopped = () =>
    props.items.filter((item) => item.activity?.status === 'interrupted').length;
  const running = () => props.items.findLast((item) => item.activity?.status === 'running');
  const summary = createMemo(() => {
    const readFiles = new Set(
      props.items.flatMap((item) =>
        item.activity?.type === 'tool' && item.activity.status === 'completed'
          ? (item.activity.files ?? [])
          : [],
      ),
    );
    const commands = props.items.filter((item) => item.activity?.type === 'command').length;
    const changed = new Set(
      props.items.flatMap((item) =>
        item.activity?.type === 'files' && item.activity.status === 'completed'
          ? (item.activity.files ?? [])
          : [],
      ),
    );
    const count = props.items.length;
    const parts = [
      readFiles.size
        ? `${readFiles.size} ${readFiles.size === 1 ? 'file' : 'files'} inspected`
        : '',
      commands ? `${commands} ${commands === 1 ? 'command' : 'commands'}` : '',
      changed.size ? `${changed.size} ${changed.size === 1 ? 'file' : 'files'} changed` : '',
    ].filter(Boolean);
    const other = props.items.filter((item) => {
      const activity = item.activity;
      return (
        activity?.type !== 'command' &&
        !(activity?.status === 'completed' && activity.files?.length)
      );
    }).length;
    if (parts.length && other)
      parts.push(`${other} other ${other === 1 ? 'operation' : 'operations'}`);
    return {
      changed: changed.size,
      text: parts.join(' · ') || `${count} ${count === 1 ? 'operation' : 'operations'}`,
    };
  });
  const stats = createMemo(() => totalStats(props.items));
  createEffect(
    on(failures, (ids, previous) => {
      if (details && [...ids].some((id) => !previous?.has(id))) details.open = true;
    }),
  );
  // Keep successful work compact; the reader opens details or uses Review changes.
  // Failures still open automatically so actionable errors cannot disappear.
  return (
    <div class="chat-activity-group">
      <details ref={details}>
        <summary
          class="chat-activity-summary"
          data-status={failures().size ? 'failed' : running() ? 'running' : 'completed'}
        >
          <span class="chat-activity-chevron" aria-hidden="true">
            <ChevronRightIcon size={14} />
          </span>
          <span class="chat-activity-label">{summary().text}</span>
          <Show when={stats()}>{(total) => <DiffStat {...total()} />}</Show>
          <Show when={failures().size}>
            <strong>{failures().size} failed</strong>
          </Show>
          <Show when={declined()}>
            <span class="chat-activity-outcome">{declined()} declined</span>
          </Show>
          <Show when={stopped()}>
            <span class="chat-activity-outcome">{stopped()} stopped</span>
          </Show>
          <Show when={running()}>
            {(item) => (
              <span class="chat-current-operation" title={item().activity?.label}>
                Running · {item().activity?.label || 'Tool activity'}
              </span>
            )}
          </Show>
        </summary>
        <For each={props.items}>
          {(item) => (
            <ActivityRow item={item} onReview={props.onReview} onOpenFile={props.onOpenFile} />
          )}
        </For>
      </details>
      <Show when={summary().changed > 0 && props.onReview}>
        <button class="chat-review btn-with-icon" onClick={() => props.onReview?.()}>
          <DiffIcon size={12} />
          Review changes ↗
        </button>
      </Show>
      <Show when={props.onOpenTour}>
        <button class="chat-review" onClick={() => props.onOpenTour?.()}>
          Open tour ↗
        </button>
      </Show>
    </div>
  );
}
