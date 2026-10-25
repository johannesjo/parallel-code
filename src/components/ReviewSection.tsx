import { For, Show, createMemo, createSignal, type JSX } from 'solid-js';
import { theme, sectionLabelStyle } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { errMessage } from '../lib/log';
import { countLabel } from '../lib/plural';
import {
  buildReviewSummary,
  reviewVerdict,
  type ReviewItem,
  type ReviewTestGroup,
} from '../lib/review-summary';
import type { EvidenceTestChange } from '../../electron/shared/evidence';
import { store } from '../store/core';
import { showNotification } from '../store/notification';
import {
  dismissReviewItem,
  restoreReviewItem,
  setReviewDismissReason,
  stageRework,
} from '../store/review';
import { keepBriefDecision, refreshTaskBrief, requestConfidenceRating } from '../store/task-brief';
import type { Task } from '../store/types';

const quietButton: JSX.CSSProperties = {
  background: 'transparent',
  border: `1px solid ${theme.border}`,
  'border-radius': 'var(--radius-sm)',
  color: theme.fg,
  'font-size': sf(12),
  padding: '4px 10px',
  cursor: 'pointer',
};

/** A pressed toggle: neutral fill, never an accent, so routine picks stay quiet. */
const pressedButton: JSX.CSSProperties = { ...quietButton, background: theme.bgHover };

/** Wide enough for either label, so pressing a toggle never shifts its row. */
const TOGGLE_WIDTH = '8.5em';

const linkButton: JSX.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: '0',
  color: theme.fgMuted,
  'font-size': sf(12),
  cursor: 'pointer',
};

const heading: JSX.CSSProperties = { ...sectionLabelStyle, 'font-size': sf(11), margin: '0' };

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

function ReworkToggle(props: {
  picked: boolean;
  label: string;
  onToggle: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={props.picked}
      onClick={() => props.onToggle()}
      style={{ ...(props.picked ? pressedButton : quietButton), 'min-width': TOGGLE_WIDTH }}
    >
      {props.picked ? '✓ In rework' : props.label}
    </button>
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
  /** Readiness checks below that failed or warn, counted into the verdict. */
  failingChecks: number;
  /** Called once a rework prompt is staged, so the dialog can close. */
  onReworkStaged: () => void;
}) {
  const summary = createMemo(() =>
    buildReviewSummary({
      brief: props.task.brief,
      confidence: props.task.confidence,
      evidence: props.task.evidence,
      dismissed: props.task.reviewDismissed,
    }),
  );
  const [picked, setPicked] = createSignal<Record<string, ReviewItem>>({});
  const [showTests, setShowTests] = createSignal(false);
  const [rating, setRating] = createSignal(false);

  // Picks of items that are gone (dismissed, kept, or rewritten away) do not count.
  const pickedItems = () => {
    const live = new Set(
      [...summary().risks, ...summary().decisions, ...summary().extras].map((entry) => entry.id),
    );
    return Object.values(picked()).filter((entry) => live.has(entry.id));
  };
  const isPicked = (entry: ReviewItem) => Object.hasOwn(picked(), entry.id);
  const toggle = (entry: ReviewItem) =>
    setPicked((prev) =>
      Object.hasOwn(prev, entry.id)
        ? Object.fromEntries(Object.entries(prev).filter(([id]) => id !== entry.id))
        : { ...prev, [entry.id]: entry },
    );

  const rate = async () => {
    if (rating()) return;
    setRating(true);
    try {
      await requestConfidenceRating(props.task.id);
      showNotification('Asked the agent to rate its work. The scores appear here when it is done.');
    } catch (error) {
      showNotification(`Could not ask for a rating: ${errMessage(error)}`);
    } finally {
      setRating(false);
    }
  };

  const stage = () => {
    if (stageRework(props.task.id, pickedItems(), '')) {
      setPicked({});
      props.onReworkStaged();
    }
  };

  const scoreLow = () => {
    const scores = summary().scores;
    if (!scores) return undefined;
    return scores.low.map((entry) => `${entry.label} ${entry.score} · ${entry.why}`);
  };
  const scoreRest = () => {
    const scores = summary().scores;
    if (!scores) return undefined;
    const fine = scores.fine.map((entry) => `${entry.label.toLowerCase()} ${entry.score}`);
    const parts = [
      fine.length > 0 && `${fine.join(', ')} look fine`,
      scores.source,
      scores.stale && 'the code changed since this rating',
    ].filter(Boolean);
    const line = parts.join(' · ');
    return line ? line.charAt(0).toUpperCase() + line.slice(1) : undefined;
  };

  const testNames = (tests: EvidenceTestChange[], mark: string) =>
    tests.map((test) => `${mark} ${test.title}`);

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
          {reviewVerdict(summary(), props.failingChecks)}
        </h3>
        <Show when={summary().goal}>
          {(goal) => <p style={{ margin: '0', color: theme.fgMuted }}>Asked: {goal()}</p>}
        </Show>
        <Show when={scoreLow()}>
          {(lines) => <For each={lines()}>{(line) => <p style={{ margin: '0' }}>{line}</p>}</For>}
        </Show>
        <Show when={scoreRest()}>
          {(line) => (
            <p style={{ margin: '0', 'font-size': sf(12), color: theme.fgSubtle }}>{line()}</p>
          )}
        </Show>
        <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '12px', 'padding-top': '4px' }}>
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
          <Show when={!props.task.confidence || summary().scores?.stale}>
            <button
              type="button"
              style={linkButton}
              disabled={rating()}
              onClick={() => void rate()}
            >
              {props.task.confidence ? 'Rate confidence again' : 'Rate confidence'}
            </button>
          </Show>
          <Show when={!store.taskBriefs && !props.task.brief}>
            <span style={{ 'font-size': sf(12), color: theme.fgSubtle }}>
              Turn on task briefs in Settings to see what changed and what is still open.
            </span>
          </Show>
        </div>
      </div>

      <Show when={summary().changes.length > 0}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
          <h4 style={heading}>What changed</h4>
          <ol
            style={{
              margin: '0',
              'padding-left': '20px',
              display: 'flex',
              'flex-direction': 'column',
              gap: '4px',
            }}
          >
            <For each={summary().changes}>{(entry) => <li>{entry.text}</li>}</For>
          </ol>
        </div>
      </Show>

      <Show when={summary().risks.length > 0 || summary().dismissed.length > 0}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
          <h4 style={heading}>Open risks</h4>
          <For each={summary().risks}>
            {(risk) => (
              <div
                style={{
                  border: `1px solid ${theme.border}`,
                  'border-radius': 'var(--radius-md)',
                  padding: '10px 12px',
                  display: 'grid',
                  'grid-template-columns': '12px minmax(0, 1fr)',
                  gap: '4px 8px',
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
                  }}
                />
                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
                  <span style={{ 'font-weight': '500' }}>{risk.text}</span>
                  <span style={{ 'font-size': sf(12), color: theme.fgSubtle }}>
                    {risk.source}
                    {risk.file ? ` · ${risk.file}` : ''}
                  </span>
                  <div style={{ display: 'flex', gap: '8px', 'padding-top': '6px' }}>
                    <ReworkToggle
                      picked={isPicked(risk)}
                      label="Add to rework"
                      onToggle={() => toggle(risk)}
                    />
                    <button
                      type="button"
                      style={{ ...quietButton, color: theme.fgMuted }}
                      onClick={() => dismissReviewItem(props.task.id, risk)}
                    >
                      Not needed
                    </button>
                  </div>
                </div>
              </div>
            )}
          </For>
          <Show when={summary().risks.length === 0}>
            <p style={{ margin: '0', color: theme.fgMuted }}>Nothing open.</p>
          </Show>
          <Show when={summary().dismissed.length > 0}>
            <p style={{ margin: '4px 0 0', 'font-size': sf(12), color: theme.fgSubtle }}>
              Dismissed · the next confidence check is told to leave these out
            </p>
            <For each={summary().dismissed}>
              {(risk) => (
                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                  <div style={{ display: 'flex', gap: '8px', 'align-items': 'baseline' }}>
                    <span style={{ flex: '1', color: theme.fgMuted }}>{risk.text}</span>
                    <button
                      type="button"
                      style={linkButton}
                      onClick={() => restoreReviewItem(props.task.id, risk.id)}
                    >
                      Undo
                    </button>
                  </div>
                  <input
                    type="text"
                    aria-label={`Why “${risk.text}” needs no work`}
                    placeholder="Why? Optional, and passed to the next confidence check"
                    value={props.task.reviewDismissed?.[risk.id]?.reason ?? ''}
                    onChange={(e) =>
                      setReviewDismissReason(props.task.id, risk.id, e.currentTarget.value)
                    }
                    style={{
                      'font-family': 'inherit',
                      'font-size': sf(12),
                      color: theme.fg,
                      background: theme.bgInput,
                      border: `1px solid ${theme.border}`,
                      'border-radius': 'var(--radius-sm)',
                      padding: '5px 8px',
                    }}
                  />
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>

      <Show when={summary().decisions.length > 0}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
          <h4 style={heading}>Decided by the agent</h4>
          <For each={summary().decisions}>
            {(decision) => (
              <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                <span style={{ flex: '1' }}>{decision.text}</span>
                <button
                  type="button"
                  style={{ ...quietButton, color: theme.fgMuted }}
                  onClick={() => keepBriefDecision(props.task.id, decision.text)}
                >
                  Keep
                </button>
                <ReworkToggle
                  picked={isPicked(decision)}
                  label="Ask to change"
                  onToggle={() => toggle(decision)}
                />
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={summary().extras.length > 0}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
          <h4 style={heading}>Also done, not asked for</h4>
          <For each={summary().extras}>
            {(extra) => (
              <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                <span style={{ flex: '1' }}>{extra.text}</span>
                <ReworkToggle
                  picked={isPicked(extra)}
                  label="Ask to revert"
                  onToggle={() => toggle(extra)}
                />
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={summary().tests}>
        {(tests) => (
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
            <h4 style={heading}>Tests</h4>
            <For each={tests().groups}>
              {(group) => <p style={{ margin: '0' }}>{testLine(group)}</p>}
            </For>
            <Show
              when={
                tests().groups.every((group) => group.removed.length === 0) &&
                tests().weakened === 0
              }
            >
              <p style={{ margin: '0', 'font-size': sf(12), color: theme.fgSubtle }}>
                None removed or weakened.
              </p>
            </Show>
            <Show when={tests().weakened > 0}>
              <p style={{ margin: '0' }}>
                {countLabel(tests().weakened, 'weakened test')}, see the evidence below.
              </p>
            </Show>
            <Show when={tests().groups.length > 0}>
              <button
                type="button"
                style={{ ...linkButton, 'align-self': 'flex-start', 'padding-top': '4px' }}
                aria-expanded={showTests()}
                onClick={() => setShowTests((v) => !v)}
              >
                {showTests() ? 'Hide test names' : 'Show test names'}
              </button>
            </Show>
            <Show when={showTests()}>
              <ul style={{ margin: '0', 'padding-left': '16px', 'font-size': sf(12) }}>
                <For
                  each={tests().groups.flatMap((group) => [
                    ...testNames(group.added, '+'),
                    ...testNames(group.changed, '~'),
                    ...testNames(group.removed, '−'),
                  ])}
                >
                  {(name) => <li style={{ 'list-style': 'none' }}>{name}</li>}
                </For>
              </ul>
            </Show>
          </div>
        )}
      </Show>

      <div
        style={{
          display: 'flex',
          gap: '12px',
          'align-items': 'center',
          'padding-top': '4px',
          'border-top': `1px solid ${theme.borderSubtle}`,
        }}
      >
        <span
          style={{ flex: '1', 'font-size': sf(12), color: theme.fgSubtle, 'padding-top': '8px' }}
        >
          {pickedItems().length > 0
            ? 'Puts one prompt in the task input for you to edit and send.'
            : 'Pick items above to ask the agent for changes.'}
        </span>
        <button
          type="button"
          style={{
            ...quietButton,
            'margin-top': '8px',
            'font-weight': '500',
            opacity: pickedItems().length > 0 ? '1' : '0.5',
            cursor: pickedItems().length > 0 ? 'pointer' : 'default',
          }}
          disabled={pickedItems().length === 0}
          onClick={stage}
        >
          Rework ({pickedItems().length})
        </button>
      </div>
    </section>
  );
}
