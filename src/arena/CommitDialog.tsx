import { Show, createSignal, createUniqueId, untrack } from 'solid-js';
import { Dialog } from '../components/Dialog';
import { GitMergeIcon } from '../components/icons';
import { arenaStore } from './store';
import type { BattleCompetitor } from './types';

interface CommitDialogProps {
  target: BattleCompetitor;
  hasCommitted: boolean;
  onCommitAndMerge: (message: string) => void;
  onDiscardAndMerge: () => void;
  onCancel: () => void;
}

export function CommitDialog(props: CommitDialogProps) {
  const titleId = createUniqueId();
  const promptSnippet = () => {
    const p = arenaStore.prompt;
    return p.slice(0, 50) + (p.length > 50 ? '...' : '');
  };
  const [commitMsg, setCommitMsg] = createSignal(
    untrack(() => `arena: ${props.target.name} — ${promptSnippet()}`),
  );

  return (
    <Dialog
      open={true}
      onClose={props.onCancel}
      width="420px"
      labelledBy={titleId}
      panelStyle={{
        background: 'transparent',
        border: 'none',
        'box-shadow': 'none',
        padding: '0',
        overflow: 'visible',
      }}
    >
      <div class="arena-commit-dialog">
        <div id={titleId} class="arena-commit-title">
          {props.target.name} has uncommitted changes
        </div>
        <label class="arena-commit-label">
          Commit message
          <input
            class="arena-commit-input"
            type="text"
            value={commitMsg()}
            onInput={(e) => setCommitMsg(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && commitMsg().trim()) props.onCommitAndMerge(commitMsg());
            }}
            autofocus
          />
        </label>
        <div class="arena-commit-actions">
          <button
            class="arena-merge-btn"
            disabled={!commitMsg().trim()}
            onClick={() => props.onCommitAndMerge(commitMsg())}
          >
            <GitMergeIcon size={14} />
            Commit &amp; Merge
          </button>
          <Show when={props.hasCommitted}>
            <button class="arena-close-btn" onClick={() => props.onDiscardAndMerge()}>
              <GitMergeIcon size={14} />
              Discard uncommitted &amp; Merge
            </button>
          </Show>
          <button class="arena-close-btn" onClick={() => props.onCancel()}>
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
}
