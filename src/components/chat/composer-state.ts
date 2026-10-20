import { batch, createEffect, createMemo, createSignal, onCleanup, untrack } from 'solid-js';
import {
  validateChatImages,
  type AgentChatState,
  type ChatImage,
} from '../../../electron/shared/agent-chat-types';
import { readChatImages } from './ChatContext';

export interface QueuedMessage {
  id: string;
  text: string;
  images: ChatImage[];
}

/** What the composer keeps across remounts of the same conversation. */
export interface ComposerMemory {
  images: ChatImage[];
  files: string[];
  queue: QueuedMessage[];
}

/** A message on its way to the agent, shown until the agent's own copy arrives. */
export interface PendingMessage {
  text: string;
  images: ChatImage[];
  /** How many user messages the log held when this one was sent. */
  after: number;
}

export interface ComposerInput {
  state: AgentChatState;
  draft: string;
  disabled: boolean;
  onDraft: (text: string) => void;
  onSend: (text: string, images: ChatImage[]) => Promise<void>;
  /** Runs a `!` command; without it, a message starting with `!` goes to the agent. */
  onShell?: (command: string) => Promise<void>;
  onStop: () => Promise<void>;
  /** Path to reference for a dropped file, or undefined when it has none on disk. */
  dropPathFor?: (file: File) => string | undefined;
}

const MAX_MESSAGE = 100_000;
const TOO_LONG = 'Enter a message of at most 100,000 characters.';

/** The command in a `!` draft, as the terminal reads it: the rest of the text after the bang. */
export function shellCommand(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed.startsWith('!') ? trimmed.slice(1).trim() : undefined;
}

/**
 * The composer's state machine: attachments, the follow-up queue, and the
 * send / queue / interrupt paths. The draft text itself lives in the task store.
 */
export function createComposer(
  props: ComposerInput,
  memory: { saved?: ComposerMemory; save: (memory: ComposerMemory) => void },
) {
  const saved = memory.saved;
  const [images, setImages] = createSignal<ChatImage[]>(saved?.images ?? []);
  const [files, setFiles] = createSignal<string[]>(saved?.files ?? []);
  const [queue, setQueue] = createSignal<QueuedMessage[]>(saved?.queue ?? []);
  // A queue restored after a remount waits for the user: the agent it was meant for is gone.
  const [queuePaused, setQueuePaused] = createSignal(!!saved?.queue.length);
  const [readingImages, setReadingImages] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [stopping, setStopping] = createSignal(false);
  const [error, setError] = createSignal('');
  const [pending, setPending] = createSignal<PendingMessage>();
  let disposed = false;
  onCleanup(() => (disposed = true));
  createEffect(() => memory.save({ images: images(), files: files(), queue: queue() }));

  const dequeue = (id: string) => setQueue((entries) => entries.filter((entry) => entry.id !== id));

  /** Delivers one message. A queued one leaves the queue in the same update that
   *  frees the composer, so the queue never sees it as still waiting. */
  async function transmit(
    text: string,
    attached: ChatImage[],
    from: { queuedId?: string; shown?: PendingMessage } = {},
  ) {
    if (sending() || stopping() || props.disabled || props.state.status !== 'ready') return false;
    const queuedId = from.queuedId;
    batch(() => {
      setSending(true);
      setError('');
      if (from.shown) setPending(from.shown);
    });
    try {
      const command = props.onShell && shellCommand(text);
      if (command) await props.onShell?.(command);
      else await props.onSend(text, attached);
      if (!disposed)
        batch(() => {
          if (queuedId) dequeue(queuedId);
          setSending(false);
        });
      return true;
    } catch (err) {
      if (!disposed)
        batch(() => {
          setError(String(err));
          setQueuePaused(true);
          setSending(false);
        });
      return false;
    }
  }

  const composedText = (text: string, referenced = files()) =>
    [
      text.trim(),
      referenced.length
        ? `Referenced files:\n${referenced.map((file) => JSON.stringify(file)).join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n') || 'Please examine the attached images.';

  /** Clears only what was sent; anything added since stays for the next message. */
  function clearSent(draft: string, attached: ChatImage[], referenced: string[]) {
    if (props.draft === draft) props.onDraft('');
    if (images() === attached) setImages([]);
    if (files() === referenced) setFiles([]);
  }

  /** Puts a failed message back, unless the user has started on another one. */
  function restore(draft: string, attached: ChatImage[], referenced: string[]) {
    if (!props.draft) props.onDraft(draft);
    if (disposed) {
      // The view closed while the message was on its way; the draft lives in the
      // task store and the attachments go where the next composer looks for them.
      // shortcut: a composer already open again keeps its own attachments and does
      // not see these — a shared store per conversation if that proves common.
      const current = memory.saved;
      if (!current?.images.length && !current?.files.length)
        memory.save({ images: attached, files: referenced, queue: current?.queue ?? queue() });
      return;
    }
    if (!images().length) setImages(attached);
    if (!files().length) setFiles(referenced);
  }

  const userCount = () => props.state.items.filter((item) => item.kind === 'user').length;

  /** What a draft sends: a shell command leaves the attachments for the next message. */
  function outgoing(text: string) {
    const shell = props.onShell && shellCommand(text) !== undefined;
    const attached = shell ? [] : images();
    const referenced = shell ? [] : files();
    const message = shell ? text.trim() : composedText(text, referenced);
    return { shell, attached, referenced, message };
  }

  async function send(text = props.draft) {
    if (readingImages() || sending() || stopping() || props.disabled) return;
    const { shell, attached, referenced, message } = outgoing(text);
    if (shell ? !shellCommand(text) : !text.trim() && !attached.length && !referenced.length)
      return;
    if (message.length > MAX_MESSAGE) {
      setError(TOO_LONG);
      return;
    }
    if (props.state.status === 'working') {
      // A pause holds the messages queued before it; a Stop or failed send from an
      // earlier turn must not hold back a queue the user starts afresh.
      if (!queue().length) setQueuePaused(false);
      setQueue((entries) => [
        ...entries,
        { id: crypto.randomUUID(), text: message, images: attached },
      ]);
      clearSent(text, attached, referenced);
      return;
    }
    if (props.state.status !== 'ready') return;
    // The agent confirms a message only once it starts answering, which can take
    // seconds; the composer empties now and the message shows as sending meanwhile.
    clearSent(text, attached, referenced);
    // A command shows up in the log as soon as it starts; nothing to stand in for it.
    const shown = shell ? undefined : { text: message, images: attached, after: userCount() };
    if (await transmit(message, attached, { shown })) return;
    batch(() => {
      setPending(undefined);
      restore(text, attached, referenced);
    });
  }

  // The sending copy gives way to the agent's own once the log has it, or once
  // the turn is over in case the agent never echoes it.
  createEffect(() => {
    const sent = pending();
    if (sent && !sending() && (userCount() > sent.after || props.state.status !== 'working'))
      setPending(undefined);
  });
  // A memo: the view scrolls to the latest message whenever this changes, and the
  // item count it reads changes on every streamed frame.
  const pendingMessage = createMemo(() => {
    const sent = pending();
    return sent && userCount() <= sent.after ? sent : undefined;
  });

  // Send the next queued follow-up once the agent is idle and nothing needs the user.
  createEffect(() => {
    const next = queue()[0];
    if (
      !next ||
      props.state.status !== 'ready' ||
      props.state.requests.length ||
      props.state.error ||
      props.disabled ||
      queuePaused() ||
      stopping() ||
      sending()
    )
      return;
    void untrack(() => transmit(next.text, next.images, { queuedId: next.id }));
  });

  // A reconnect replaces the agent process; queued work waits for an explicit retry.
  createEffect(() => {
    const status = props.state.status;
    if ((status === 'closed' || status === 'starting') && untrack(queue).length)
      setQueuePaused(true);
  });

  function retryQueue() {
    const next = queue()[0];
    setQueuePaused(false);
    if (next) void transmit(next.text, next.images, { queuedId: next.id });
  }

  async function stop(interruptAndSend = false) {
    if (stopping()) return;
    const draft = props.draft;
    const { attached, referenced, message } = outgoing(draft);
    if (interruptAndSend && message.length > MAX_MESSAGE) {
      setError(TOO_LONG);
      return;
    }
    batch(() => {
      setStopping(true);
      setQueuePaused(true);
      setError('');
    });
    try {
      await props.onStop();
      if (disposed || !interruptAndSend) return;
      batch(() => {
        setQueue((entries) => [
          { id: crypto.randomUUID(), text: message, images: attached },
          ...entries,
        ]);
        clearSent(draft, attached, referenced);
        setQueuePaused(false);
      });
    } catch (err) {
      if (!disposed) setError(String(err));
    } finally {
      if (!disposed) setStopping(false);
    }
  }

  async function addImages(selected: File[]) {
    if (readingImages() || sending() || stopping() || props.disabled) return;
    setReadingImages(true);
    setError('');
    try {
      const added = await readChatImages(selected);
      if (!disposed) setImages(validateChatImages([...images(), ...added]));
    } catch (err) {
      if (!disposed) setError(String(err));
    } finally {
      if (!disposed) setReadingImages(false);
    }
  }

  /** Images attach inline; other files are referenced by path, so they need one on disk. */
  function addDropped(dropped: File[]) {
    if (sending() || stopping() || props.disabled) return;
    const isImage = (file: File) => file.type.startsWith('image/');
    const others = dropped
      .filter((file) => !isImage(file))
      .map((file) => ({ name: file.name, path: props.dropPathFor?.(file) }));
    const paths = others.flatMap((file) => file.path ?? []);
    const rejected = others.filter((file) => !file.path).map((file) => file.name);
    if (paths.length) setFiles((current) => [...new Set([...current, ...paths])]);
    const pictures = dropped.filter(isImage);
    if (pictures.length) void addImages(pictures);
    if (rejected.length)
      setError(
        `No file on disk for: ${rejected.join(', ')}. Save it first, then drop the saved file.`,
      );
  }

  /** Puts earlier text back in the composer, asking before it replaces a draft. */
  function reuse(text: string, attached: ChatImage[] = []) {
    if (props.draft.trim() && !window.confirm('Replace the unsent draft with this prompt?'))
      return false;
    props.onDraft(text);
    setImages(attached);
    setFiles([]);
    return true;
  }

  function editQueued(entry: QueuedMessage) {
    if (!reuse(entry.text, entry.images)) return false;
    dequeue(entry.id);
    return true;
  }

  return {
    /** Shell commands can run here at all. */
    canRunShell: () => !!props.onShell,
    /** The draft is a `!` command, so sending runs it instead of messaging the agent. */
    shellMode: () => !!props.onShell && shellCommand(props.draft) !== undefined,
    images,
    files,
    setFiles,
    removeImage: (index: number) => setImages(images().filter((_, i) => i !== index)),
    pendingMessage,
    queue,
    queuePaused,
    dequeue,
    retryQueue,
    editQueued,
    readingImages,
    sending,
    stopping,
    error,
    setError,
    send,
    stop,
    addImages,
    addDropped,
  };
}

export type Composer = ReturnType<typeof createComposer>;
