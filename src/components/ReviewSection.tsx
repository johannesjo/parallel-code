import { For, Show, createMemo, createSignal, createUniqueId, onMount, type JSX } from 'solid-js';
import { dialogButtonStyle, theme, sectionLabelStyle } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { errMessage } from '../lib/log';
import {
  REVIEW_REASON_MAX,
  buildReviewSummary,
  reviewVerdict,
  type ReviewDecision,
  type ReviewItem,
  type ReviewRisk,
  type ReviewTestGroup,
} from '../lib/review-summary';
import { store } from '../store/core';
import { showNotification } from '../store/notification';
import {
  dismissReviewItem,
  restoreReviewItem,
  setReviewDismissReason,
  stageRework,
} from '../store/review';
import {
  briefTargetAgentName,
  keepBriefDecision,
  refreshCodeFingerprint,
  refreshTaskBrief,
  reopenBriefDecision,
  requestConfidenceRating,
} from '../store/task-brief';
import type { Task } from '../store/types';

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

/** Wide enough for the tick, so pressing a toggle never shifts its row. */
const TOGGLE_WIDTH = '9em';

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

const heading: JSX.CSSProperties = { ...sectionLabelStyle, 'font-size': sf(11), margin: '0' };

const list: JSX.CSSProperties = {
  margin: '0',
  padding: '0',
  'list-style': 'none',
  display: 'flex',
  'flex-direction': 'column',
  gap: '8px',
};

/** Longer lists fold, so the merge controls below stay in reach. */
const FOLD_AT = 5;

const KIND_LABEL: Record<ReviewTestGroup['kind'], string> = {
  unit: 'Unit',
  e2e: 'End to end',
};

function testLine(group: ReviewTestGroup): string {
  const parts = [
    group.added.length && `${group.added.length} added`,
    group.changed.length && `${group.changed.length} changed`,
    group.removed.length && `${group.removed.length} removed`,
  ].filter(Boolean);
  return `${KIND_LABEL[group.kind]}: ${parts.join(', ')}`;
}

/** The pressed state is carried by aria-pressed; the label stays the same. */
function ReworkToggle(props: {
  picked: boolean;
  label: string;
  describedBy: string;
  onToggle: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={props.picked}
      aria-describedby={props.describedBy}
      onClick={() => props.onToggle()}
      style={{ ...(props.picked ? pressedButton : quietButton), 'min-width': TOGGLE_WIDTH }}
    >
      <span aria-hidden="true" style={{ visibility: props.picked ? 'visible' : 'hidden' }}>
        ✓{' '}
      </span>
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
      <ul style={list}>
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
 * The review half of finishing a task: what changed, what is still a risk and
 * what the agent decided on its own, built from the brief, the confidence
 * rating and the evidence scan. Items can be collected into one rework prompt,
 * which is staged in the task input for the user to send.
 */
export function ReviewSection(props: {
  task: Task;
  /** HEAD of the worktree, to tell a test scan of an older commit. */
  headSha?: string | null;
  /** The verify command failed on this commit. */
  verifyFailed: boolean;
  /** Called once a rework prompt is staged, so the dialog can close. */
  onReworkStaged: () => void;
}) {
  const summary = createMemo(() =>
    buildReviewSummary({
      brief: props.task.brief,
      confidence: props.task.confidence,
      evidence: props.task.evidence,
      dismissed: props.task.reviewDismissed,
      codeFingerprint: props.task.codeFingerprint,
      headSha: props.headSha,
    }),
  );
  // Rows are keyed by id, so a recomputed summary keeps their focus and input.
  const byId = createMemo(() => {
    const map = new Map<string, ReviewItem>();
    for (const entry of [...summary().risks, ...summary().decisions, ...summary().extras])
      map.set(entry.id, entry);
    return map;
  });
  const risk = (id: string) => byId().get(id) as ReviewRisk | undefined;
  const decision = (id: string) => byId().get(id) as ReviewDecision | undefined;

  // Rows handled while the dialog is open stay where they are, collapsed, so
  // the next row never slides under the pointer.
  const [touched, setTouched] = createSignal<ReadonlySet<string>>(new Set());
  const touch = (id: string) => setTouched((prev) => new Set(prev).add(id));
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(new Set());
  const [showDismissed, setShowDismissed] = createSignal(false);
  const [showTests, setShowTests] = createSignal(false);
  const [rating, setRating] = createSignal(false);
  // The rating that was current when the user asked, so the button waits for a new one.
  const [askedOver, setAskedOver] = createSignal<number | null>();

  onMount(() => {
    // A rating is judged against the code as it is now, not as the last brief saw it.
    if (props.task.confidence) void refreshCodeFingerprint(props.task.id);
  });

  const riskIds = (dismissed: boolean) =>
    summary()
      .risks.filter((entry) =>
        dismissed
          ? entry.dismissed && !touched().has(entry.id)
          : !entry.dismissed || touched().has(entry.id),
      )
      .map((entry) => entry.id);
  const decisionIds = () =>
    summary()
      .decisions.filter((entry) => !entry.state || touched().has(entry.id))
      .map((entry) => entry.id);
  const extraIds = () => summary().extras.map((entry) => entry.id);

  // Only picks of items that are still there and still open go out.
  const pickedItems = () =>
    [...picked()].flatMap((id) => {
      const entry = byId().get(id);
      if (!entry) return [];
      if (entry.kind === 'risk' && (entry as ReviewRisk).dismissed) return [];
      if (entry.kind === 'decision' && (entry as ReviewDecision).state) return [];
      return [entry];
    });
  const canRework = () => riskIds(false).length + decisionIds().length + extraIds().length > 0;
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const awaitingRating = () => {
    const asked = askedOver();
    return asked !== undefined && (props.task.confidence?.publishedAt ?? null) === asked;
  };
  const rate = async () => {
    if (rating() || awaitingRating()) return;
    setRating(true);
    try {
      await requestConfidenceRating(props.task.id);
      setAskedOver(props.task.confidence?.publishedAt ?? null);
    } catch (error) {
      showNotification(`Could not ask for a rating: ${errMessage(error)}`);
    } finally {
      setRating(false);
    }
  };
  const rateLabel = () => {
    if (awaitingRating()) return 'Rating asked for · scores appear here';
    const target = briefTargetAgentName(props.task);
    const label = props.task.confidence ? 'Rate confidence again' : 'Rate confidence';
    return target ? `${label} · ${target}` : label;
  };

  const stage = () => {
    if (stageRework(props.task.id, pickedItems())) {
      setPicked(new Set<string>());
      props.onReworkStaged();
    }
  };

  const scoreRest = () => {
    const scores = summary().scores;
    if (!scores) return undefined;
    const fine = scores.fine.map((entry) => `${entry.label} ${entry.score}`);
    const parts = [
      fine.length > 0 && `${fine.join(', ')} ${fine.length === 1 ? 'looks' : 'look'} fine`,
      scores.source,
      scores.stale && 'the code changed since this rating',
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : undefined;
  };

  const RiskRow = (rowProps: { id: string }) => {
    const textId = createUniqueId();
    const entry = () => risk(rowProps.id);
    return (
      <Show when={entry()}>
        {(r) => (
          <li
            style={{
              display: 'grid',
              'grid-template-columns': '12px minmax(0, 1fr)',
              gap: '0 8px',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: '6px',
                height: '6px',
                'border-radius': '50%',
                background: theme.warning,
                'margin-top': '7px',
                visibility: r().urgent && !r().dismissed ? 'visible' : 'hidden',
              }}
            />
            <div
              style={{ display: 'flex', 'flex-direction': 'column', gap: '2px', 'min-width': '0' }}
            >
              <span
                id={textId}
                style={{
                  color: r().dismissed ? theme.fgMuted : theme.fg,
                  'font-weight': r().dismissed ? '400' : '500',
                }}
              >
                {r().text}
              </span>
              <span style={{ 'font-size': sf(12), color: theme.fgSubtle }}>
                {r().dismissed ? 'Not needed' : r().source}
                {r().file && !r().dismissed ? ` · ${r().file}` : ''}
              </span>
              <Show
                when={r().dismissed}
                fallback={
                  <div style={{ display: 'flex', gap: '8px', 'padding-top': '4px' }}>
                    <ReworkToggle
                      picked={picked().has(r().id)}
                      label="Add to rework"
                      describedBy={textId}
                      onToggle={() => toggle(r().id)}
                    />
                    <button
                      type="button"
                      style={quietButton}
                      aria-describedby={textId}
                      onClick={() => {
                        touch(r().id);
                        dismissReviewItem(props.task.id, r());
                      }}
                    >
                      Not needed
                    </button>
                  </div>
                }
              >
                <div
                  style={{
                    display: 'flex',
                    gap: '8px',
                    'align-items': 'center',
                    'padding-top': '4px',
                  }}
                >
                  <input
                    type="text"
                    maxLength={REVIEW_REASON_MAX}
                    aria-label="Why it needs no work"
                    aria-describedby={textId}
                    placeholder="Why? The next confidence check reads this"
                    value={props.task.reviewDismissed?.[r().id]?.reason ?? ''}
                    onInput={(e) =>
                      setReviewDismissReason(props.task.id, r().id, e.currentTarget.value)
                    }
                    style={{
                      flex: '1',
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
                  <button
                    type="button"
                    style={quietButton}
                    aria-describedby={textId}
                    onClick={() => restoreReviewItem(props.task.id, r().id)}
                  >
                    Undo
                  </button>
                </div>
              </Show>
            </div>
          </li>
        )}
      </Show>
    );
  };

  const DecisionRow = (rowProps: { id: string }) => {
    const textId = createUniqueId();
    const entry = () => decision(rowProps.id);
    return (
      <Show when={entry()}>
        {(d) => (
          <li style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
            <span
              id={textId}
              style={{ flex: '1', 'min-width': '0', color: d().state ? theme.fgMuted : theme.fg }}
            >
              {d().text}
              <Show when={d().state}>
                {(state) => (
                  <span style={{ 'font-size': sf(12), color: theme.fgSubtle }}>
                    {state() === 'kept' ? ' · kept' : ' · change asked for'}
                  </span>
                )}
              </Show>
            </span>
            <Show
              when={d().state}
              fallback={
                <>
                  <button
                    type="button"
                    style={quietButton}
                    aria-describedby={textId}
                    onClick={() => {
                      touch(d().id);
                      keepBriefDecision(props.task.id, d().text);
                    }}
                  >
                    Keep
                  </button>
                  <ReworkToggle
                    picked={picked().has(d().id)}
                    label="Ask to change"
                    describedBy={textId}
                    onToggle={() => toggle(d().id)}
                  />
                </>
              }
            >
              <button
                type="button"
                style={quietButton}
                aria-describedby={textId}
                onClick={() => reopenBriefDecision(props.task.id, d().text)}
              >
                Undo
              </button>
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
          <li style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
            <span id={textId} style={{ flex: '1', 'min-width': '0' }}>
              {x().text}
            </span>
            <ReworkToggle
              picked={picked().has(x().id)}
              label="Ask to revert"
              describedBy={textId}
              onToggle={() => toggle(x().id)}
            />
          </li>
        )}
      </Show>
    );
  };

  return (
    <section
      aria-labelledby={`finish-review-${props.task.id}`}
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: '16px',
        'margin-bottom': '20px',
        'font-size': sf(13),
        'line-height': '1.45',
      }}
    >
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
        <h3
          id={`finish-review-${props.task.id}`}
          style={{ margin: '0', 'font-size': sf(15), 'font-weight': '600', color: theme.fg }}
        >
          {reviewVerdict(summary(), props.verifyFailed)}
        </h3>
        <Show when={summary().goal}>
          {(goal) => <p style={{ margin: '0', color: theme.fgMuted }}>Asked: {goal()}</p>}
        </Show>
        <Show when={summary().scores}>
          {(scores) => (
            <div style={{ opacity: scores().stale ? '0.7' : '1' }}>
              <For each={scores().low}>
                {(entry) => (
                  <p style={{ margin: '0' }}>
                    {entry.label} {entry.score} · {entry.why}
                  </p>
                )}
              </For>
              <Show when={scoreRest()}>
                {(line) => (
                  <p style={{ margin: '0', 'font-size': sf(12), color: theme.fgSubtle }}>
                    {line()}
                  </p>
                )}
              </Show>
            </div>
          )}
        </Show>
        <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '12px', 'padding-top': '4px' }}>
          <Show when={!props.task.confidence || summary().scores?.stale}>
            <button
              type="button"
              style={linkButton}
              disabled={rating() || awaitingRating()}
              onClick={() => void rate()}
            >
              {rateLabel()}
            </button>
          </Show>
          <Show when={store.taskBriefs && !props.task.brief}>
            <button
              type="button"
              style={linkButton}
              disabled={props.task.briefStatus?.state === 'generating'}
              onClick={() => void refreshTaskBrief(props.task.id, { force: true })}
            >
              {props.task.briefStatus?.state === 'generating'
                ? 'Writing the brief…'
                : 'Write brief'}
            </button>
          </Show>
        </div>
        <Show when={!props.task.brief}>
          <p style={{ margin: '0', 'font-size': sf(12), color: theme.fgSubtle }}>
            {props.task.briefStatus?.state === 'failed'
              ? `The brief could not be written: ${props.task.briefStatus.message}`
              : store.taskBriefs
                ? 'The brief says what changed and what is still open.'
                : 'Turn on task briefs in Settings to see what changed and what is still open.'}
          </p>
        </Show>
      </div>

      <Show when={summary().changes.length > 0}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
          <h4 style={heading}>What changed</h4>
          <ul style={{ ...list, gap: '4px' }}>
            <For each={summary().changes}>{(entry) => <li>{entry.text}</li>}</For>
          </ul>
        </div>
      </Show>

      <Show when={summary().risks.length > 0}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
          <h4 style={heading}>Open risks</h4>
          <Show
            when={riskIds(false).length > 0}
            fallback={<p style={{ margin: '0', color: theme.fgMuted }}>Nothing open.</p>}
          >
            <Folded ids={riskIds(false)}>{(id) => <RiskRow id={id} />}</Folded>
          </Show>
          <Show when={riskIds(true).length > 0}>
            <button
              type="button"
              style={{ ...linkButton, 'align-self': 'flex-start' }}
              aria-expanded={showDismissed()}
              onClick={() => setShowDismissed((v) => !v)}
            >
              {showDismissed() ? 'Hide dismissed' : `Dismissed earlier (${riskIds(true).length})`}
            </button>
            <Show when={showDismissed()}>
              <ul style={list}>
                <For each={riskIds(true)}>{(id) => <RiskRow id={id} />}</For>
              </ul>
            </Show>
          </Show>
        </div>
      </Show>

      <Show when={decisionIds().length > 0}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
          <h4 style={heading}>Decided by the agent</h4>
          <Folded ids={decisionIds()}>{(id) => <DecisionRow id={id} />}</Folded>
        </div>
      </Show>

      <Show when={extraIds().length > 0}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
          <h4 style={heading}>Also done, not asked for</h4>
          <Folded ids={extraIds()}>{(id) => <ExtraRow id={id} />}</Folded>
        </div>
      </Show>

      <Show when={summary().tests}>
        {(tests) => (
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
            <h4 style={heading}>Tests</h4>
            <For each={tests().groups}>
              {(group) => <p style={{ margin: '0' }}>{testLine(group)}</p>}
            </For>
            <Show when={tests().outdated}>
              <p style={{ margin: '0', 'font-size': sf(12), color: theme.fgSubtle }}>
                From the evidence scan of an older commit.
              </p>
            </Show>
            <button
              type="button"
              style={{ ...linkButton, 'align-self': 'flex-start', 'margin-top': '4px' }}
              aria-expanded={showTests()}
              onClick={() => setShowTests((v) => !v)}
            >
              {showTests() ? 'Hide test names' : 'Show test names'}
            </button>
            <Show when={showTests()}>
              <ul style={{ ...list, gap: '2px', 'font-size': sf(12) }}>
                <For each={tests().groups}>
                  {(group) => (
                    <>
                      <For each={group.added}>{(test) => <li>+ {test.title}</li>}</For>
                      <For each={group.changed}>{(test) => <li>~ {test.title}</li>}</For>
                      <For each={group.removed}>{(test) => <li>− {test.title}</li>}</For>
                    </>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        )}
      </Show>

      <Show when={canRework()}>
        <div
          style={{
            display: 'flex',
            gap: '12px',
            'align-items': 'center',
            'padding-top': '12px',
            'border-top': `1px solid ${theme.borderSubtle}`,
          }}
        >
          <span style={{ flex: '1', 'font-size': sf(12), color: theme.fgSubtle }}>
            {pickedItems().length > 0
              ? 'Puts one prompt in the task input for you to edit and send.'
              : 'Pick items above to ask the agent for changes.'}
          </span>
          <button
            type="button"
            style={dialogButtonStyle(false, pickedItems().length === 0)}
            disabled={pickedItems().length === 0}
            onClick={stage}
          >
            Rework ({pickedItems().length})
          </button>
        </div>
      </Show>
    </section>
  );
}
