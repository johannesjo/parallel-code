import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  on,
  onMount,
  untrack,
  type JSX,
} from 'solid-js';
import { dialogButtonStyle, theme, sectionLabelStyle } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { errMessage, warn as logWarn } from '../lib/log';
import {
  REVIEW_REASON_MAX,
  buildReviewSummary,
  reviewVerdict,
  type ReviewItem,
  type ReviewRisk,
} from '../lib/review-summary';
import {
  dismissReviewItem,
  restoreReviewItem,
  setReviewDismissReason,
  stageRework,
} from '../store/review';
import { refreshCodeFingerprint } from '../store/task-brief';
import { getProject } from '../store/projects';
import { cancelReview, startReview } from '../store/review-run';
import {
  reviewerName,
  setTaskReviewModel,
  takeUnseenReview,
  taskReviewModel,
} from '../store/task-review';
import type { Task } from '../store/types';
import { CheckIcon, CloseIcon, PlusIcon, ReviewIcon } from './icons';
import { createHeightTransition } from './understanding/create-height-transition';
import { ReviewChecksPicker } from './ReviewChecksPicker';
import { ReviewerMenu } from './ReviewerMenu';
import { ReviewScoreCard } from './ReviewScoreCard';

const quietButton: JSX.CSSProperties = {
  background: 'transparent',
  border: `1px solid ${theme.border}`,
  'border-radius': 'var(--radius-sm)',
  color: theme.fgMuted,
  'font-size': sf(12),
  padding: '3px 10px',
  cursor: 'pointer',
  'white-space': 'nowrap',
};

/** A pressed toggle: neutral fill, never an accent, so routine picks stay quiet. */
const pressedButton: JSX.CSSProperties = {
  ...quietButton,
  background: theme.bgHover,
  color: theme.fg,
};

/** Wide enough for the icon and label, so pressing a toggle never shifts its row. */
const TOGGLE_WIDTH = '6.5em';

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

// Quieter than the dialog's own section labels, so the nesting reads.
const heading4: JSX.CSSProperties = {
  ...sectionLabelStyle,
  'font-size': sf(11),
  color: theme.fgSubtle,
  margin: '0',
};

const list: JSX.CSSProperties = {
  margin: '0',
  padding: '0',
  'list-style': 'none',
  display: 'flex',
  'flex-direction': 'column',
  gap: '8px',
};

/** Rows of items to act on, split by hairlines (see .review-rows). */
const rowList: JSX.CSSProperties = { ...list, gap: '0' };

/** The item's text, then its actions at the end of its first line. */
const rowGrid: JSX.CSSProperties = {
  display: 'grid',
  'grid-template-columns': 'minmax(0, 1fr) auto',
  gap: '0 8px',
  'align-items': 'start',
};

/** Longer lists fold, so the merge controls below stay in reach. */
const FOLD_AT = 5;

/** The pressed state is carried by aria-pressed; the label stays the same. */
function ReworkToggle(props: {
  picked: boolean;
  label: string;
  title: string;
  describedBy: string;
  onToggle: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={props.picked}
      aria-describedby={props.describedBy}
      title={props.title}
      onClick={() => props.onToggle()}
      class="btn-with-icon"
      style={{ ...(props.picked ? pressedButton : quietButton), 'min-width': TOGGLE_WIDTH }}
    >
      {/* Both icons are the same size, so pressing swaps one for the other in place. */}
      <Show when={props.picked} fallback={<PlusIcon size={12} />}>
        <CheckIcon size={12} />
      </Show>
      {props.label}
    </button>
  );
}

/** Shows the first few ids and folds the rest behind one button. */
function Folded(props: { ids: string[]; children: (id: string) => JSX.Element }) {
  const [all, setAll] = createSignal(false);
  const shown = () => (all() ? props.ids : props.ids.slice(0, FOLD_AT));
  return (
    <>
      <ul class="review-rows" style={rowList}>
        <For each={shown()}>{(id) => props.children(id)}</For>
      </ul>
      <Show when={props.ids.length > FOLD_AT}>
        <button
          type="button"
          style={{ ...linkButton, 'align-self': 'flex-start' }}
          aria-expanded={all()}
          onClick={() => setAll((v) => !v)}
        >
          {all() ? 'Show fewer' : `Show ${props.ids.length - FOLD_AT} more`}
        </button>
      </Show>
    </>
  );
}

/**
 * The review half of finishing a task, one follow-up box until asked for.
 * Run review asks a separate reviewer model for a confidence rating; the result lists what is
 * still a risk and what was done without being asked, built from the brief's
 * goal and the rating. Items can be collected into one rework prompt, which is
 * staged in the task input for the user to send. Opening the dialog sends
 * nothing.
 */
export function ReviewSection(props: {
  task: Task;
  /** The verify command failed on this commit. */
  verifyFailed: boolean;
  /** Called once a rework prompt is staged, so the dialog can close. */
  onReworkStaged: () => void;
  /** Opens a changed file at a line, above the dialog. */
  onOpenFile: (file: string, line?: number) => void;
}) {
  const bodyId = createUniqueId();
  const summary = createMemo(() =>
    buildReviewSummary({
      brief: props.task.brief,
      confidence: props.task.confidence,
      dismissed: props.task.reviewDismissed,
      codeFingerprint: props.task.codeFingerprint,
    }),
  );
  // Rows are keyed by id, so a recomputed summary keeps their focus and input.
  const byId = createMemo(() => {
    const map = new Map<string, ReviewItem>();
    for (const entry of [...summary().risks, ...summary().extras]) map.set(entry.id, entry);
    return map;
  });
  const risk = (id: string) => byId().get(id) as ReviewRisk | undefined;

  const hasResult = () => !!props.task.confidence;
  const running = () => props.task.reviewStatus?.state === 'running';
  const failure = () => {
    const status = props.task.reviewStatus;
    return status?.state === 'failed' ? status.message : undefined;
  };
  // Folded by default, so the merge controls stay in reach: the button's verdict
  // says enough. Only an unseen, current review opens as the dialog opens; later changes
  // leave it as the user set it, so nothing collapses under them.
  const current = () => {
    const scores = summary().scores;
    return !!scores && !scores.stale && !!props.task.codeFingerprint;
  };
  // A review that finished while the dialog was closed opens too: the user asked for it.
  const [open, setOpenSignal] = createSignal(
    untrack(() => takeUnseenReview(props.task.id) && current()),
  );
  let userToggled = false;
  const setOpen = (next: boolean | ((prev: boolean) => boolean)) => {
    userToggled = true;
    setOpenSignal(next);
  };
  const openUnlessToggled = () => {
    if (!userToggled && current()) setOpenSignal(true);
  };
  // A review the user watched finish is of the code as it is now, and they asked for it.
  createEffect(
    on(running, (now, was) => {
      if (was && !now) {
        takeUnseenReview(props.task.id);
        openUnlessToggled();
      }
    }),
  );

  // Rows handled while the dialog is open stay where they are, collapsed, so
  // the next row never slides under the pointer.
  const [touched, setTouched] = createSignal<ReadonlySet<string>>(new Set());
  const touch = (id: string) => setTouched((prev) => new Set(prev).add(id));
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(new Set());
  const [showDismissed, setShowDismissed] = createSignal(false);

  onMount(() => {
    // A rating is judged against the code as it is now, not as the last brief saw it.
    if (props.task.confidence)
      refreshCodeFingerprint(props.task.id).catch((error: unknown) =>
        logWarn('review', 'Reading the code failed', { error: errMessage(error) }),
      );
  });

  const riskIds = (dismissed: boolean) =>
    summary()
      .risks.filter((entry) =>
        dismissed
          ? entry.dismissed && !touched().has(entry.id)
          : !entry.dismissed || touched().has(entry.id),
      )
      .map((entry) => entry.id);
  const extraIds = () => summary().extras.map((entry) => entry.id);

  // Only picks of items that are still there and still open go out.
  const pickedItems = () =>
    [...picked()].flatMap((id) => {
      const entry = byId().get(id);
      if (!entry) return [];
      if (entry.kind === 'risk' && (entry as ReviewRisk).dismissed) return [];
      return [entry];
    });
  const canRework = () => riskIds(false).length + extraIds().length > 0;
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // A project's first review asks what to run and on which reviewer; later ones run
  // the saved pick at once. The chevron beside the button switches the reviewer, and
  // Change settings is there for the odd task whose checks differ.
  const [picking, setPicking] = createSignal(false);
  const pickedChecks = () => getProject(props.task.projectId)?.reviewChecks;
  // The review runs in the store, so closing the dialog leaves it running.
  const rate = () => {
    if (pickedChecks() === undefined) setPicking(true);
    else startReview(props.task.id);
  };
  const rateLabel = () => (props.task.confidence ? 'Run review again' : 'Run review');

  const stage = () => {
    if (stageRework(props.task.id, pickedItems())) {
      setPicked(new Set<string>());
      props.onReworkStaged();
    }
  };

  const actionToggles = () => (hasResult() || picking()) && !running();
  const actionLabel = () => {
    if (running()) return `Reviewing with ${reviewerName(props.task.id)}`;
    if (hasResult()) return `Review · ${reviewVerdict(summary())}`;
    return failure() ? 'Retry review' : 'Run review';
  };
  const actionTitle = () => {
    if (running()) return undefined;
    if (picking()) return 'Close the review settings';
    if (hasResult()) return open() ? 'Hide the review' : 'Show the review';
    return `Checks the work against what you asked, with ${reviewerName(props.task.id)}`;
  };
  const RiskRow = (rowProps: { id: string }) => {
    const textId = createUniqueId();
    const entry = () => risk(rowProps.id);
    return (
      <Show when={entry()}>
        {(r) => (
          <li style={rowGrid}>
            <div
              // Where it came from and the score it lowers help weigh it, but only on a closer look.
              title={[r().source, r().axis && `Lowers ${r().axis}`].filter(Boolean).join(' · ')}
              style={{ display: 'flex', 'flex-direction': 'column', gap: '2px', 'min-width': '0' }}
            >
              <span id={textId} style={{ color: r().dismissed ? theme.fgMuted : theme.fg }}>
                {r().text}
              </span>
              <Show when={r().dismissed || r().unconfirmed || r().file}>
                <span style={{ 'font-size': sf(12), color: theme.fgSubtle }}>
                  {[r().dismissed && 'Accepted', r().unconfirmed && 'Not confirmed', r().file]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </Show>
            </div>
            <Show
              when={r().dismissed}
              fallback={
                <div style={{ display: 'flex', gap: '6px' }}>
                  <ReworkToggle
                    picked={picked().has(r().id)}
                    label="Fix"
                    title="Add to the rework prompt"
                    describedBy={textId}
                    onToggle={() => toggle(r().id)}
                  />
                  <button
                    type="button"
                    style={quietButton}
                    title="Needs no work; say why below"
                    aria-describedby={textId}
                    onClick={() => {
                      touch(r().id);
                      dismissReviewItem(props.task.id, r());
                    }}
                  >
                    Accept
                  </button>
                </div>
              }
            >
              <button
                type="button"
                style={quietButton}
                aria-describedby={textId}
                onClick={() => restoreReviewItem(props.task.id, r().id)}
              >
                Undo
              </button>
              <input
                type="text"
                maxLength={REVIEW_REASON_MAX}
                aria-label="Why it needs no work"
                aria-describedby={textId}
                placeholder="Why it is fine; the next review reads this"
                value={props.task.reviewDismissed?.[r().id]?.reason ?? ''}
                onInput={(e) =>
                  setReviewDismissReason(props.task.id, r().id, e.currentTarget.value)
                }
                style={{
                  'grid-column': '1 / -1',
                  'margin-top': '6px',
                  'min-width': '0',
                  'font-family': 'inherit',
                  'font-size': sf(12),
                  color: theme.fg,
                  background: theme.bgInput,
                  border: `1px solid ${theme.border}`,
                  'border-radius': 'var(--radius-sm)',
                  padding: '4px 8px',
                }}
              />
            </Show>
          </li>
        )}
      </Show>
    );
  };

  const ExtraRow = (rowProps: { id: string }) => {
    const textId = createUniqueId();
    const entry = () => byId().get(rowProps.id);
    return (
      <Show when={entry()}>
        {(x) => (
          <li style={rowGrid}>
            <div
              style={{ display: 'flex', 'flex-direction': 'column', gap: '2px', 'min-width': '0' }}
            >
              <span id={textId}>{x().text}</span>
              <Show when={x().file}>
                {(file) => (
                  <span style={{ 'font-size': sf(12), color: theme.fgSubtle }}>{file()}</span>
                )}
              </Show>
            </div>
            <ReworkToggle
              picked={picked().has(x().id)}
              label="Revert"
              title="Ask the agent to undo it"
              describedBy={textId}
              onToggle={() => toggle(x().id)}
            />
          </li>
        )}
      </Show>
    );
  };

  // A review being redone hides the old one: its scores are about to be replaced.
  const body = () => (
    <Show when={open() && hasResult() && !running()}>
      <div
        id={bodyId}
        style={{
          display: 'flex',
          'flex-direction': 'column',
          gap: '22px',
          'margin-top': '8px',
          padding: '18px 20px',
          border: `1px solid ${theme.border}`,
          'border-radius': 'var(--radius-md)',
        }}
      >
        <Show when={summary().scores}>
          {(scores) => <ReviewScoreCard scores={scores()} goal={summary().goal} />}
        </Show>

        <Show when={summary().risks.length > 0}>
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
            <h4 style={heading4}>
              Unsure · {riskIds(false).length > 0 ? `${summary().openRisks} open` : 'none open'}
            </h4>
            <Show when={riskIds(false).length > 0}>
              <Folded ids={riskIds(false)}>{(id) => <RiskRow id={id} />}</Folded>
            </Show>
            <Show when={riskIds(true).length > 0}>
              <button
                type="button"
                style={{ ...linkButton, 'align-self': 'flex-start' }}
                aria-expanded={showDismissed()}
                onClick={() => setShowDismissed((v) => !v)}
              >
                {showDismissed() ? 'Hide accepted' : `Accepted earlier (${riskIds(true).length})`}
              </button>
              <Show when={showDismissed()}>
                <ul class="review-rows" style={rowList}>
                  <For each={riskIds(true)}>{(id) => <RiskRow id={id} />}</For>
                </ul>
              </Show>
            </Show>
          </div>
        </Show>

        <Show when={extraIds().length > 0}>
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
            <h4 style={heading4}>Not asked for</h4>
            <Folded ids={extraIds()}>{(id) => <ExtraRow id={id} />}</Folded>
          </div>
        </Show>

        {/* Open, not folded: what a user will notice is what the merge is about. */}
        <Show when={summary().changes.length > 0}>
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
            <h4 style={heading4}>What changed</h4>
            <ol style={list}>
              <For each={summary().changes}>
                {(change) => (
                  <li
                    title={change.tested ? `Tested: ${change.tested}` : undefined}
                    style={{
                      display: 'grid',
                      'grid-template-columns': 'minmax(0, 1fr) auto',
                      gap: '0 12px',
                      'align-items': 'baseline',
                    }}
                  >
                    <span>
                      {change.now}
                      <Show when={change.before}>
                        {(before) => <span style={{ color: theme.fgMuted }}> {before()}</span>}
                      </Show>
                    </span>
                    {/* Only the gap is worth a word; which tests cover the rest is on hover. */}
                    <Show when={!change.tested}>
                      <span style={{ 'font-size': sf(12), color: theme.fgSubtle }}>untested</span>
                    </Show>
                  </li>
                )}
              </For>
            </ol>
          </div>
        </Show>

        <Show when={summary().keyLine}>
          {(key) => (
            <p style={{ margin: '0', 'font-size': sf(12), color: theme.fgMuted }}>
              <span style={{ color: theme.fgSubtle }}>Read first</span>{' '}
              <button
                type="button"
                style={{ ...linkButton, 'font-family': "'JetBrains Mono', monospace" }}
                title="Open the diff at this line"
                onClick={() => props.onOpenFile(key().file, key().line)}
              >
                {key().file}
                {key().line ? `:${key().line}` : ''}
              </button>{' '}
              · {key().why}
            </p>
          )}
        </Show>

        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
          <div
            style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '12px', 'align-items': 'center' }}
          >
            <button type="button" style={linkButton} onClick={rate}>
              {rateLabel()}
            </button>
            <button
              type="button"
              style={linkButton}
              title={`Checks and reviewer (${reviewerName(props.task.id)})`}
              onClick={() => setPicking(true)}
            >
              Change settings
            </button>
            <Show when={canRework()}>
              <button
                type="button"
                style={{
                  ...dialogButtonStyle(false, pickedItems().length === 0),
                  'margin-left': 'auto',
                }}
                disabled={pickedItems().length === 0}
                title={
                  pickedItems().length > 0
                    ? 'Puts one prompt in the task input for you to edit and send'
                    : 'Pick Fix or Revert above to ask the agent for changes'
                }
                onClick={stage}
              >
                Rework ({pickedItems().length})
              </button>
            </Show>
          </div>
          <Show when={props.task.confidence && failure()}>
            {(message) => (
              <p style={{ margin: '0', 'font-size': sf(12), color: theme.fgSubtle }}>
                The last review failed, so these scores are older: {message()}
              </p>
            )}
          </Show>
        </div>
      </div>
    </Show>
  );

  let action: HTMLButtonElement | undefined;
  return (
    <div>
      <div class="finish-followup">
        <div class="change-tour-row">
          <button
            ref={action}
            type="button"
            class="change-tour-action"
            // Shows the run while it lasts; the × beside it is what stops it.
            aria-busy={running()}
            aria-expanded={actionToggles() ? open() || picking() : undefined}
            aria-controls={actionToggles() && !picking() ? bodyId : undefined}
            title={actionTitle()}
            onClick={() => {
              if (running()) return;
              if (picking()) setPicking(false);
              else if (hasResult()) setOpen((v) => !v);
              else rate();
            }}
          >
            {/* One icon in every state: a turning chevron made the button read as a collapsible section. */}
            <Show when={running()} fallback={<ReviewIcon size={14} />}>
              <span class="inline-spinner" aria-hidden="true" />
            </Show>
            <span class="change-tour-action-label">{actionLabel()}</span>
          </button>
          {/* Like the tour's model; waits while the settings carry their own pick. A running
              review keeps the reviewer it started with, so the × to cancel takes its place. */}
          <Show
            when={running()}
            fallback={
              <ReviewerMenu
                class="change-tour-model"
                chevronOnly
                disabled={picking()}
                value={taskReviewModel(props.task.id)}
                onChange={(model) => setTaskReviewModel(props.task.id, model)}
              />
            }
          >
            <button
              type="button"
              class="change-tour-model"
              aria-label="Cancel the review"
              title="Cancel the review"
              onClick={() => {
                // The × goes away with the run; keep focus on the review, not the page.
                action?.focus();
                cancelReview(props.task.id);
              }}
            >
              <CloseIcon size={12} />
            </button>
          </Show>
        </div>
        <Show when={!props.task.confidence && failure()}>
          {(message) => (
            <p
              role="alert"
              style={{
                color: theme.error,
                margin: '0',
                padding: '6px 10px',
                'overflow-wrap': 'anywhere',
              }}
            >
              The review failed: {message()}
            </p>
          )}
        </Show>
      </div>
      {/* Right under its button, so the result reads as the review's. Eases the
          dialog to the new height as the review or the picker opens and closes. */}
      <div ref={(element) => createHeightTransition(element)} class="finish-followup-below">
        <Show when={picking()} fallback={body()}>
          <ReviewChecksPicker
            task={props.task}
            onCancel={() => setPicking(false)}
            onStart={() => {
              setPicking(false);
              startReview(props.task.id);
            }}
          />
        </Show>
      </div>
    </div>
  );
}
