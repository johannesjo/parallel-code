import { createSignal, onCleanup } from 'solid-js';
import { Channel } from '../lib/ipc';
import { errMessage } from '../lib/log';
import { pushTask } from '../store/store';
import type { Task } from '../store/types';

interface PushRunProps {
  task: Task;
  onStart: () => void;
  onDone: (success: boolean) => void;
}

/**
 * A push of the task branch. It lives with the always-mounted finish dialog,
 * not with the dialog's content, so closing the dialog keeps it running.
 */
export function createPushRun(props: PushRunProps) {
  const [pushing, setPushing] = createSignal(false);
  const [output, setOutput] = createSignal('');
  const [error, setError] = createSignal('');
  let channel: Channel<string> | null = null;
  let onOutput: (() => void) | undefined;

  onCleanup(() => {
    channel?.cleanup?.();
    channel = null;
  });

  function start(): void {
    const taskId = props.task.id;
    const onDone = props.onDone;
    channel?.cleanup?.();
    setError('');
    setPushing(true);
    setOutput('');
    channel = new Channel<string>();
    channel.onmessage = (text) => {
      setOutput((prev) => prev + text);
      onOutput?.();
    };
    props.onStart();
    void pushTask(taskId, channel)
      .then(() => onDone(true))
      .catch((err: unknown) => {
        setError(errMessage(err));
        onDone(false);
      })
      .finally(() => {
        setPushing(false);
        channel?.cleanup?.();
        channel = null;
      });
  }

  /** Clears a finished push's output, so a reopened dialog starts fresh. */
  function reset(): void {
    if (pushing()) return;
    setError('');
    setOutput('');
  }

  return {
    pushing,
    output,
    error,
    start,
    reset,
    /** Called after each output chunk, e.g. to keep the log scrolled. */
    onOutput: (callback: () => void) => {
      onOutput = callback;
    },
  };
}

export type PushRun = ReturnType<typeof createPushRun>;
