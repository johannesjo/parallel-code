import { For, Show, createMemo, createSignal } from 'solid-js';
import type { ChatDiff } from '../../../electron/shared/agent-chat-types';
import { parseDiff } from './diff-lines';
import { DiffIcon } from '../icons';

/** Enough to judge a change at a glance; the rest is one click away. */
const PREVIEW_LINES = 40;

export function DiffStat(props: { added: number; removed: number }) {
  return (
    <span class="chat-diff-stat" aria-label={`${props.added} added, ${props.removed} removed`}>
      <span class="chat-diff-added">+{props.added}</span>{' '}
      <span class="chat-diff-removed">−{props.removed}</span>
    </span>
  );
}

/** One file's change, coloured by line, with a way to open the file or its full diff. */
export function DiffView(props: {
  diff: ChatDiff;
  /** Proposed edits have no worktree diff to review yet. */
  applied: boolean;
  onReview?: (path?: string) => void;
  onOpenFile?: (path: string) => void;
}) {
  const lines = createMemo(() => parseDiff(props.diff.diff));
  const [expanded, setExpanded] = createSignal(false);
  const shown = () => (expanded() ? lines() : lines().slice(0, PREVIEW_LINES));
  const numbered = () => lines().some((line) => line.kind === 'hunk');
  return (
    <div class="chat-diff">
      <div class="chat-diff-header">
        <button
          class="chat-diff-path"
          onClick={() => props.onOpenFile?.(props.diff.path)}
          disabled={!props.onOpenFile}
          title={`Open ${props.diff.path}`}
        >
          {props.diff.path}
        </button>
        <DiffStat added={props.diff.added} removed={props.diff.removed} />
        <Show when={props.applied && props.onReview}>
          <button class="btn-with-icon" onClick={() => props.onReview?.(props.diff.path)}>
            <DiffIcon size={12} />
            Review diff
          </button>
        </Show>
      </div>
      <pre class="chat-diff-body" data-numbered={numbered()}>
        <For each={shown()}>
          {(line) => (
            <span class="chat-diff-line" data-kind={line.kind}>
              <Show when={numbered()}>
                <span class="chat-diff-number">{line.old ?? ''}</span>
                <span class="chat-diff-number">{line.new ?? ''}</span>
              </Show>
              <span class="chat-diff-text">{line.kind === 'hunk' ? '⋯' : line.text}</span>
            </span>
          )}
        </For>
      </pre>
      <Show when={lines().length > PREVIEW_LINES}>
        <button class="chat-diff-more" onClick={() => setExpanded(!expanded())}>
          {expanded() ? 'Show less' : `Show all ${lines().length} lines`}
        </button>
      </Show>
    </div>
  );
}
