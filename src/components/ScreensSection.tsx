import {
  For,
  Show,
  createEffect,
  createSignal,
  createUniqueId,
  on,
  onCleanup,
  onMount,
  untrack,
  type JSX,
} from 'solid-js';
import type { ScreenImage } from '../../electron/shared/task-screens';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { errMessage, warn as logWarn } from '../lib/log';
import { sf } from '../lib/fontScale';
import { theme } from '../lib/theme';
import { showNotification } from '../store/notification';
import { refreshCodeFingerprint } from '../store/task-brief';
import {
  areTaskScreensOutdated,
  cancelTaskScreens,
  captureTaskScreens,
  takeUnseenScreens,
  taskScreens,
} from '../store/task-screens';
import { CloseIcon, ImageIcon } from './icons';
import { ScreensApproval } from './ScreensApproval';
import { ScreenViewer, viewerImages } from './ScreenViewer';
import { createHeightTransition } from './understanding/create-height-transition';

/** "45s", or "3m 05s" once a run takes minutes. */
function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** The current time, ticking each second while `active` is true. */
function createClock(active: () => boolean): () => number {
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!active()) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  return now;
}

const CAPTURE_TITLE =
  'Runs Claude Code for up to 10 minutes: it starts this project before and after the task with your shell, and screenshots what changed';

/** What the screens step needs to show its state and fold its result. */
interface ScreensProps {
  taskId: string;
  disabled?: boolean;
  /** The task's current commit, to tell shots of older code. */
  headSha?: string | null;
}

const doneScreens = (taskId: string) => {
  const s = taskScreens(taskId);
  return s?.state === 'done' ? s : undefined;
};

/** The screens step's button: starts a capture, then shows and hides what it captured. */
function ScreensAction(
  props: ScreensProps & { open: boolean; bodyId: string; onToggle: () => void },
) {
  const status = () => taskScreens(props.taskId);
  const running = () => status()?.state === 'running';
  const waiting = () => {
    const s = status();
    return s?.state === 'running' && !!s.commands;
  };
  const result = () => doneScreens(props.taskId);
  const now = createClock(running);
  onMount(() => {
    // Edits made since the last turn are only seen by reading the diff again.
    if (status()?.state !== 'done') return;
    refreshCodeFingerprint(props.taskId).catch((error: unknown) =>
      logWarn('taskScreens', 'Reading the code failed', { error: errMessage(error) }),
    );
  });
  // The run takes minutes; its latest step shows it is still getting somewhere.
  const progress = () => {
    const s = status();
    if (s?.state === 'running') {
      return `${s.step ?? 'Starting'} · ${formatElapsed(now() - s.startedAt)}`;
    }
    if (!result()) return 'Takes a few minutes';
    return areTaskScreensOutdated(props.taskId, props.headSha)
      ? 'Out of date: the code changed since'
      : 'Matches the current code';
  };
  const label = () => {
    if (running()) return 'Capturing before & after';
    const count = result()?.shots.length;
    if (count !== undefined) return `Screens · ${count ? `${count} captured` : 'none captured'}`;
    return status()?.state === 'failed' ? 'Retry capture' : 'Capture before & after';
  };
  const toggles = () => !!result();
  const title = () => {
    if (running()) return undefined;
    if (toggles()) return props.open ? 'Hide the screens' : 'Show the screens';
    return CAPTURE_TITLE;
  };
  let action: HTMLButtonElement | undefined;
  return (
    <div class="finish-followup">
      <div class="change-tour-row">
        <button
          ref={action}
          type="button"
          class="change-tour-action"
          // Showing a past capture needs no commits; starting one does.
          disabled={props.disabled && !running() && !toggles()}
          // Shows the run while it lasts; the × beside it is what stops it.
          aria-busy={running()}
          aria-expanded={toggles() ? props.open : undefined}
          aria-controls={toggles() ? props.bodyId : undefined}
          title={title()}
          onClick={() => {
            if (toggles()) props.onToggle();
            else if (!running()) void captureTaskScreens(props.taskId);
          }}
        >
          <Show when={running() && !waiting()} fallback={<ImageIcon size={14} />}>
            <span class="inline-spinner" aria-hidden="true" />
          </Show>
          <span class="change-tour-action-label">
            {label()}
            {/* Always there, so starting a run never moves the content below. Hidden
                from screen readers: a clock in the button's name would change every second. */}
            <span class="screens-progress" aria-hidden="true" style={{ 'font-size': sf(11) }}>
              {progress()}
            </span>
          </span>
        </button>
        <Show when={running()}>
          <button
            type="button"
            class="change-tour-model"
            aria-label="Cancel the capture"
            title="Cancel the capture"
            onClick={() => {
              // The × goes away with the run; keep focus on the step, not the page.
              action?.focus();
              cancelTaskScreens(props.taskId);
            }}
          >
            <CloseIcon size={12} />
          </button>
        </Show>
      </div>
    </div>
  );
}

const openImage = (image: ScreenImage) => {
  invoke(IPC.OpenPath, { filePath: image.path }).catch((error: unknown) =>
    showNotification(`Could not open the screenshot: ${errMessage(error)}`),
  );
};

function Frame(props: { caption: string; image?: ScreenImage; alt: string; onOpen: () => void }) {
  return (
    <figure style={{ margin: '0', flex: '1 1 0', 'min-width': '0' }}>
      <figcaption style={{ color: theme.fgMuted, 'font-size': sf(11), 'margin-bottom': '4px' }}>
        {props.caption}
      </figcaption>
      <Show
        when={props.image}
        fallback={<p style={{ margin: '0', color: theme.fgSubtle }}>New screen</p>}
      >
        {(image) => (
          <button type="button" class="screens-frame" title="View full size" onClick={props.onOpen}>
            <img src={image().dataUrl} alt={props.alt} />
          </button>
        )}
      </Show>
    </figure>
  );
}

const linkButton: JSX.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: '0',
  color: theme.fgMuted,
  'font-size': sf(12),
  cursor: 'pointer',
  'text-decoration': 'underline',
  'text-underline-offset': '3px',
};

// CLI stderr can run long; the rest is one click away.
const SHORT_FAILURE_CHARS = 300;

/** Why the capture failed, shortened until the user asks for all of it. */
function CaptureFailure(props: { message: string }) {
  const [full, setFull] = createSignal(false);
  const long = () => props.message.length > SHORT_FAILURE_CHARS;
  const shown = () =>
    long() && !full() ? `${props.message.slice(0, SHORT_FAILURE_CHARS)}…` : props.message;
  return (
    <p
      role="alert"
      style={{
        margin: '8px 0 0',
        color: theme.error,
        'font-size': sf(12),
        'white-space': 'pre-wrap',
        'overflow-wrap': 'anywhere',
      }}
    >
      Screens could not be captured: {shown()}
      <Show when={long()}>
        {' '}
        <button
          type="button"
          style={linkButton}
          aria-expanded={full()}
          onClick={() => setFull((value) => !value)}
        >
          {full() ? 'Show less' : 'Show full error'}
        </button>
      </Show>
    </p>
  );
}

/** The captured screens, before beside after, folded under the screens button. */
function ScreensGallery(props: ScreensProps & { open: boolean; bodyId: string }) {
  const failure = () => {
    const s = taskScreens(props.taskId);
    return s?.state === 'failed' ? s.message : undefined;
  };
  const result = () => (props.open ? doneScreens(props.taskId) : undefined);
  const outdated = () => areTaskScreensOutdated(props.taskId, props.headSha);
  const images = () => viewerImages(result()?.shots ?? []);
  const [viewing, setViewing] = createSignal<number>();
  // A new capture replaces the images the viewer points into.
  createEffect(on(result, () => setViewing(undefined), { defer: true }));
  const open = (shot: number, side: 'Before' | 'After') =>
    setViewing(images().findIndex((image) => image.shot === shot && image.side === side));
  return (
    <>
      <Show when={failure()}>{(message) => <CaptureFailure message={message()} />}</Show>
      <Show when={result()}>
        {(done) => (
          <section
            id={props.bodyId}
            aria-label="Before and after screenshots"
            style={{ 'margin-top': '8px', 'font-size': sf(12) }}
          >
            <Show when={outdated()}>
              <p style={{ margin: '0 0 8px', color: theme.fgMuted }}>
                Captured before the latest changes; capture again to see the current screens.
              </p>
            </Show>
            <Show when={done().note}>
              {(note) => <p style={{ margin: '0 0 8px', color: theme.fgMuted }}>{note()}</p>}
            </Show>
            <For each={done().shots}>
              {(shot, index) => (
                <div style={{ 'margin-bottom': '12px' }}>
                  <div style={{ 'font-weight': '500', 'margin-bottom': '4px' }}>{shot.label}</div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <Frame
                      caption="Before"
                      image={shot.before}
                      alt={`${shot.label}, before`}
                      onOpen={() => open(index(), 'Before')}
                    />
                    <Frame
                      caption="After"
                      image={shot.after}
                      alt={`${shot.label}, after`}
                      onOpen={() => open(index(), 'After')}
                    />
                  </div>
                </div>
              )}
            </For>
            <button
              type="button"
              style={linkButton}
              disabled={props.disabled}
              title={CAPTURE_TITLE}
              onClick={() => void captureTaskScreens(props.taskId)}
            >
              Capture again
            </button>
          </section>
        )}
      </Show>
      <ScreenViewer
        images={images()}
        index={viewing()}
        onIndex={setViewing}
        onOpenExternal={openImage}
      />
    </>
  );
}

/**
 * Finish's screenshots step: its button, with what it captured folded beneath
 * it, so the screens read as the button's result.
 */
export function ScreensFollowUp(props: ScreensProps) {
  const bodyId = createUniqueId();
  const running = () => taskScreens(props.taskId)?.state === 'running';
  // Folded as the dialog opens, so the merge controls stay in reach; screens
  // that arrived since they were last shown, or that the user watched arrive,
  // are what they asked to see.
  const [open, setOpen] = createSignal(untrack(() => takeUnseenScreens(props.taskId)));
  createEffect(
    on(running, (now, was) => {
      if (was && !now && takeUnseenScreens(props.taskId)) setOpen(true);
    }),
  );
  return (
    <div>
      <ScreensAction {...props} open={open()} bodyId={bodyId} onToggle={() => setOpen((v) => !v)} />
      <div ref={(element) => createHeightTransition(element)} class="finish-followup-below">
        <ScreensApproval taskId={props.taskId} />
        <ScreensGallery {...props} open={open()} bodyId={bodyId} />
      </div>
    </div>
  );
}
