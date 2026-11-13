import { Show, createEffect, createSignal, createUniqueId, on } from 'solid-js';
import { startCloudSession } from '../store/store';
import { theme } from '../lib/theme';
import type { Task } from '../store/types';
import { ConfirmDialog } from './ConfirmDialog';
import { messageFieldStyle } from './MergeSection';
import { createPushRun } from './push-run';

interface CloudHandoffDialogProps {
  open: boolean;
  task: Task;
  /** Shows the task, where the cloud session's terminal opens. */
  showTask: () => void;
  onDone: () => void;
}

/**
 * The cloud session starts without this conversation, so the prompt names the task.
 * Not the prompt history: it records every answer typed into the terminal and drops old entries.
 */
function cloudHandoffPrompt(task: Pick<Task, 'name'>): string {
  return `Continue this task: ${task.name}\nThe branch has the work so far.`;
}

/**
 * Confirms a cloud handoff: optionally pushes the branch, since the cloud
 * clones it from GitHub, then runs `claude --cloud` in a new task terminal.
 */
export function CloudHandoffDialog(props: CloudHandoffDialogProps) {
  const promptId = createUniqueId();
  const [prompt, setPrompt] = createSignal('');
  const [push, setPush] = createSignal(true);
  const pushRun = createPushRun({
    get task() {
      return props.task;
    },
    onStart: () => undefined,
    onDone: () => undefined,
  });
  const canPush = () => props.task.gitIsolation === 'worktree';
  // Each opening is one attempt; a push that outlives its attempt starts nothing.
  let attempt = 0;

  // Only opening refills the prompt; task updates while it is open keep the user's edits.
  createEffect(
    on(
      () => props.open,
      (open) => {
        attempt++;
        if (!open) return;
        setPrompt(cloudHandoffPrompt(props.task));
        pushRun.reset();
      },
    ),
  );

  async function confirm(): Promise<void> {
    const mine = attempt;
    if (canPush() && push() && !(await pushRun.start())) return;
    // Cancelled while the push ran: the branch is pushed, but nothing starts.
    if (mine !== attempt) return;
    startCloudSession(props.task.id, prompt());
    props.showTask();
    props.onDone();
  }

  return (
    <ConfirmDialog
      open={props.open}
      title="Continue in cloud"
      width="520px"
      confirmLabel="Start cloud session"
      confirmLoading={pushRun.pushing()}
      confirmDisabled={!prompt().trim() || pushRun.pushing()}
      autoFocusCancel={false}
      message={
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
          <p style={{ margin: '0' }}>
            Starts a Claude Code session on claude.ai from <code>{props.task.branchName}</code>.
            When it clones from GitHub, only pushed commits reach it. Without a remote or the Claude
            GitHub App, Claude Code uploads the local repository instead, including uncommitted
            changes to tracked files. The local agent keeps running.
          </p>
          <label for={promptId} style={{ 'font-size': '12px', color: theme.fgMuted }}>
            Prompt for the cloud session
          </label>
          <textarea
            id={promptId}
            value={prompt()}
            rows={6}
            disabled={pushRun.pushing()}
            onInput={(e) => setPrompt(e.currentTarget.value)}
            style={{ ...messageFieldStyle, resize: 'vertical' }}
          />
          <Show when={canPush()}>
            <label style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
              <input
                type="checkbox"
                checked={push()}
                disabled={pushRun.pushing()}
                onChange={(e) => setPush(e.currentTarget.checked)}
              />
              Push {props.task.branchName} to origin first
            </label>
          </Show>
          {/* Reserved, so a failed push does not move the fields above. */}
          <p
            role="alert"
            style={{
              margin: '0',
              'min-height': '18px',
              'font-size': '12px',
              color: theme.error,
              visibility: pushRun.error() ? 'visible' : 'hidden',
            }}
          >
            Push failed: {pushRun.error()}
          </p>
        </div>
      }
      onConfirm={() => void confirm()}
      onCancel={props.onDone}
    />
  );
}
