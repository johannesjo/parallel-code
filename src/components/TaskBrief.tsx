import { For, Show, createMemo, createSignal, onCleanup, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { createAnchorEffect, placeBelow } from '../lib/floating';
import { formatRelativeAge } from '../lib/relativeAge';
import { errMessage } from '../lib/log';
import { isConfidenceStale } from '../lib/task-confidence';
import type { BriefItem } from '../lib/task-brief';
import type { ConfidenceFinding } from '../../electron/shared/task-confidence';
import {
  changeBriefDecision,
  keepBriefDecision,
  refreshTaskBrief,
  reopenBriefDecision,
  refreshCodeFingerprint,
  requestConfidenceRating,
} from '../store/task-brief';
import { showNotification } from '../store/notification';
import { store } from '../store/core';
import type { Task } from '../store/types';

/** Scores below this are the one thing on the card that earns a colour. */
const LOW_SCORE = 60;
const CARD_WIDTH = 480;
const MONO = "'JetBrains Mono', monospace";

interface CardItem extends BriefItem {
  /** Added from the published rating rather than the brief. */
  fromRating?: boolean;
}

function findingItems(findings: readonly ConfidenceFinding[], kinds: string[]): CardItem[] {
  return findings
    .filter((f) => kinds.includes(f.kind))
    .map((f) => ({ text: f.text, ...(f.file && { file: f.file }), fromRating: true }));
}

function scoreColor(score: number, stale: boolean): string {
  if (stale) return theme.fgSubtle;
  return score < LOW_SCORE ? theme.warning : theme.fg;
}

const sectionLabel: JSX.CSSProperties = {
  'font-size': sf(10),
  'letter-spacing': '0.06em',
  'text-transform': 'uppercase',
  color: theme.fgMuted,
  'padding-top': '2px',
};

const quietButton: JSX.CSSProperties = {
  background: 'transparent',
  border: `1px solid ${theme.border}`,
  'border-radius': 'var(--radius-sm)',
  color: theme.fgMuted,
  'font-size': sf(11),
  padding: '3px 9px',
  cursor: 'pointer',
};

const linkButton: JSX.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: '0',
  color: theme.fgMuted,
  'font-size': sf(11),
  cursor: 'pointer',
  'text-decoration': 'underline',
  'text-underline-offset': '3px',
};

function useConfidenceView(task: () => Task) {
  const stale = createMemo(() => {
    const confidence = task().confidence;
    if (!confidence) return false;
    // The newest code read wins: a brief, or a check made when the card opened.
    const code = task().codeFingerprint;
    const brief = task().brief;
    const latest = code ? { generatedAt: code.at, fingerprint: code.fingerprint } : brief;
    return isConfidenceStale(confidence, latest);
  });
  return { stale };
}

interface TaskBriefBarProps {
  task: Task;
  onFileClick?: (file: string) => void;
  onWalkThrough?: () => void;
  walkThroughDisabled?: boolean;
}

/**
 * The task brief in the task header: one compact line (headline and any
 * confidence scores) that opens the full brief in a card below it.
 */
export function TaskBriefBar(props: TaskBriefBarProps) {
  let anchor: HTMLButtonElement | undefined;
  let card: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [place, setPlace] = createSignal({ top: 0, right: 0, maxHeight: 400 });
  const { stale } = useConfidenceView(() => props.task);

  createAnchorEffect(open, () => {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(CARD_WIDTH, window.innerWidth - 24);
    setPlace(
      placeBelow({ top: rect.top, right: rect.right, bottom: rect.bottom }, width, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  });

  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as Node | null;
    if (target && (card?.contains(target) || anchor?.contains(target))) return;
    setOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    setOpen(false);
    anchor?.focus();
  };
  const toggle = () => {
    const next = !open();
    setOpen(next);
    if (next) {
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('keydown', onKeyDown, true);
      // Move focus into the card so keyboard users land on its controls.
      queueMicrotask(() => card?.querySelector<HTMLElement>('button, textarea')?.focus());
      // Check whether a rating still matches the code; briefs do this after each turn.
      if (props.task.confidence) void refreshCodeFingerprint(props.task.id);
    } else {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    }
  };
  const close = () => {
    if (open()) toggle();
  };
  onCleanup(() => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
  });

  const headline = () => {
    const brief = props.task.brief?.brief;
    if (!store.taskBriefs) return 'Confidence rating';
    if (brief) return brief.headline || brief.goal;
    if (props.task.briefStatus?.state === 'generating') return 'Writing the brief…';
    return 'The brief appears after the agent finishes a turn';
  };
  const statusNote = () => {
    const status = props.task.briefStatus;
    if (status?.state === 'generating' && props.task.brief) return 'updating';
    if (status?.state === 'failed') return 'brief failed';
    return '';
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        class="task-brief-bar"
        aria-haspopup="dialog"
        aria-expanded={open()}
        title={props.task.briefStatus?.state === 'failed' ? props.task.briefStatus.message : ''}
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '8px',
          width: '100%',
          height: '24px',
          'min-width': '0',
          padding: '0 12px',
          margin: '0',
          border: 'none',
          'border-bottom': `1px solid ${theme.border}`,
          background: 'transparent',
          color: props.task.brief ? theme.fg : theme.fgMuted,
          'font-size': sf(11),
          'font-family': 'inherit',
          'text-align': 'left',
          cursor: 'pointer',
          overflow: 'hidden',
          'white-space': 'nowrap',
        }}
      >
        <span
          style={{ flex: '1', 'min-width': '0', overflow: 'hidden', 'text-overflow': 'ellipsis' }}
        >
          {headline()}
        </span>
        <For each={props.task.confidence?.scores ?? []}>
          {(score) => (
            <span style={{ 'flex-shrink': '0', color: theme.fgMuted }}>
              {score.label}{' '}
              <span style={{ 'font-family': MONO, color: scoreColor(score.score, stale()) }}>
                {score.score}%
              </span>
            </span>
          )}
        </For>
        <Show when={stale()}>
          <span style={{ 'flex-shrink': '0', color: theme.fgSubtle, 'font-style': 'italic' }}>
            out of date
          </span>
        </Show>
        <Show when={statusNote()}>
          <span style={{ 'flex-shrink': '0', color: theme.fgSubtle }}>{statusNote()}</span>
        </Show>
        <span aria-hidden="true" style={{ 'flex-shrink': '0', color: theme.fgMuted }}>
          {open() ? '▴' : '▾'}
        </span>
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={card}
            role="dialog"
            aria-label="Task brief"
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              top: `${place().top}px`,
              right: `${place().right}px`,
              width: `${Math.min(CARD_WIDTH, window.innerWidth - 24)}px`,
              'max-height': `${place().maxHeight}px`,
              overflow: 'auto',
              'z-index': '1000',
              background: theme.bgElevated,
              border: `1px solid ${theme.border}`,
              'border-radius': 'var(--radius-md)',
              'box-shadow': '0 8px 24px rgba(0, 0, 0, 0.35)',
              color: theme.fg,
            }}
          >
            <TaskBriefCard
              task={props.task}
              stale={stale()}
              onFileClick={(file) => {
                close();
                props.onFileClick?.(file);
              }}
              onWalkThrough={
                props.onWalkThrough
                  ? () => {
                      close();
                      props.onWalkThrough?.();
                    }
                  : undefined
              }
              walkThroughDisabled={props.walkThroughDisabled}
            />
          </div>
        </Portal>
      </Show>
    </>
  );
}

function ItemList(props: { items: CardItem[]; onFileClick?: (file: string) => void }) {
  return (
    <ul
      style={{
        'list-style': 'none',
        margin: '0',
        padding: '0',
        display: 'flex',
        'flex-direction': 'column',
        gap: '8px',
      }}
    >
      <For each={props.items}>
        {(item) => (
          <li style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
            <span style={{ 'font-size': sf(12), 'line-height': '1.45' }}>{item.text}</span>
            <Show when={item.file || item.fromRating}>
              <span style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                <Show when={item.file}>
                  {(file) => (
                    <button
                      type="button"
                      title="Show in changed files"
                      onClick={() => props.onFileClick?.(file())}
                      style={{
                        ...quietButton,
                        'font-family': MONO,
                        'font-size': sf(10),
                        padding: '1px 6px',
                        'max-width': '100%',
                        overflow: 'hidden',
                        'text-overflow': 'ellipsis',
                        'white-space': 'nowrap',
                      }}
                    >
                      {file()}
                    </button>
                  )}
                </Show>
                <Show when={item.fromRating}>
                  <span style={{ 'font-size': sf(10), color: theme.fgMuted }}>from the rating</span>
                </Show>
              </span>
            </Show>
          </li>
        )}
      </For>
    </ul>
  );
}

function Section(props: { label: string; children: JSX.Element }) {
  return (
    <div
      style={{
        display: 'grid',
        'grid-template-columns': '64px minmax(0, 1fr)',
        'column-gap': '12px',
      }}
    >
      <div style={sectionLabel}>{props.label}</div>
      <div style={{ 'min-width': '0' }}>{props.children}</div>
    </div>
  );
}

/**
 * A correction being typed, kept on the card by decision text so a brief
 * rewrite cannot discard it or re-enable Send while it is on its way.
 */
interface DecisionEdit {
  draft: string;
  sending: boolean;
}

function DecisionRow(props: {
  task: Task;
  item: BriefItem;
  edit: DecisionEdit | undefined;
  setEdit: (text: string, edit: DecisionEdit | undefined) => void;
}) {
  const state = () => props.task.brief?.decisions[props.item.text];
  const editing = () => !!props.edit;
  const draft = () => props.edit?.draft ?? '';
  const sending = () => props.edit?.sending ?? false;
  const setDraft = (value: string) =>
    props.setEdit(props.item.text, { draft: value, sending: sending() });
  const setEditing = (on: boolean) =>
    props.setEdit(
      props.item.text,
      on ? { draft: `About your decision "${props.item.text}": `, sending: false } : undefined,
    );

  const send = async () => {
    const text = draft().trim();
    if (!text || sending()) return;
    const decision = props.item.text;
    props.setEdit(decision, { draft: draft(), sending: true });
    try {
      await changeBriefDecision(props.task.id, decision, text);
      props.setEdit(decision, undefined);
    } catch (error) {
      props.setEdit(decision, { draft: draft(), sending: false });
      showNotification(`Could not send the change: ${errMessage(error)}`);
    }
  };

  return (
    <li style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
      <span
        style={{
          'font-size': sf(12),
          'line-height': '1.45',
          color: state() === 'sent' ? theme.fgMuted : theme.fg,
          'text-decoration': state() === 'sent' ? 'line-through' : undefined,
        }}
      >
        {props.item.text}
      </span>
      <Show when={!state() && !editing()}>
        <span style={{ display: 'flex', gap: '6px' }}>
          <button
            type="button"
            style={quietButton}
            onClick={() => keepBriefDecision(props.task.id, props.item.text)}
          >
            Keep
          </button>
          <button type="button" style={quietButton} onClick={() => setEditing(true)}>
            Change…
          </button>
        </span>
      </Show>
      <Show when={editing()}>
        <label style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
          <span style={{ 'font-size': sf(10), color: theme.fgMuted }}>Sent to the agent</span>
          <textarea
            rows={3}
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
            }}
            ref={(el) => queueMicrotask(() => el.focus())}
            style={{
              resize: 'vertical',
              padding: '6px 8px',
              'font-family': 'inherit',
              'font-size': sf(12),
              color: theme.fg,
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              'border-radius': 'var(--radius-sm)',
            }}
          />
        </label>
        <span style={{ display: 'flex', gap: '6px' }}>
          <button
            type="button"
            style={{ ...quietButton, color: theme.fg }}
            disabled={sending() || !draft().trim()}
            onClick={() => void send()}
          >
            {sending() ? 'Sending…' : 'Send to agent'}
          </button>
          <button type="button" style={quietButton} onClick={() => setEditing(false)}>
            Cancel
          </button>
        </span>
      </Show>
      <Show when={state()}>
        {(current) => (
          <span style={{ 'font-size': sf(11), color: theme.fgMuted }}>
            {current() === 'sent' ? 'Change sent to the agent' : 'Kept'} ·{' '}
            <button
              type="button"
              style={linkButton}
              onClick={() => reopenBriefDecision(props.task.id, props.item.text)}
            >
              undo
            </button>
          </span>
        )}
      </Show>
    </li>
  );
}

function TaskBriefCard(props: {
  task: Task;
  stale: boolean;
  onFileClick?: (file: string) => void;
  onWalkThrough?: () => void;
  walkThroughDisabled?: boolean;
}) {
  const [showTurns, setShowTurns] = createSignal(false);
  const [rating, setRating] = createSignal(false);
  const [decisionEdits, setDecisionEdits] = createSignal<Record<string, DecisionEdit>>({});
  const setDecisionEdit = (text: string, value: DecisionEdit | undefined) =>
    setDecisionEdits((prev) => {
      const rest = Object.fromEntries(Object.entries(prev).filter(([key]) => key !== text));
      return value ? { ...rest, [text]: value } : rest;
    });
  // Keeps the relative times current while the card stays open.
  const [now, setNow] = createSignal(Date.now());
  const ticker = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => clearInterval(ticker));
  const brief = () => props.task.brief?.brief;
  const findings = () => props.task.confidence?.findings ?? [];
  const open = () => [...(brief()?.open ?? []), ...findingItems(findings(), ['gap', 'risk'])];
  const extra = () => [...(brief()?.extra ?? []), ...findingItems(findings(), ['extra'])];

  const rate = async () => {
    if (rating()) return;
    setRating(true);
    try {
      await requestConfidenceRating(props.task.id);
    } catch (error) {
      showNotification(`Could not ask for a rating: ${errMessage(error)}`);
    } finally {
      setRating(false);
    }
  };

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column' }}>
      <div
        style={{
          padding: '14px 16px 12px',
          display: 'flex',
          'flex-direction': 'column',
          gap: '8px',
          'border-bottom': `1px solid ${theme.borderSubtle}`,
        }}
      >
        <span style={{ 'font-size': sf(13), 'font-weight': '600' }}>{props.task.name}</span>
        <Show
          when={brief()}
          fallback={
            <span style={{ 'font-size': sf(12), color: theme.fgMuted, 'line-height': '1.45' }}>
              {props.task.briefStatus?.state === 'failed'
                ? `The brief could not be written: ${props.task.briefStatus.message}`
                : store.taskBriefs
                  ? 'The brief is written by the naming model after each agent turn.'
                  : 'Task briefs are off in Settings; ratings still show here.'}
            </span>
          }
        >
          {(b) => (
            <span style={{ 'font-size': sf(12), color: theme.fgMuted, 'line-height': '1.45' }}>
              {b().goal}
            </span>
          )}
        </Show>
        <Show when={props.task.confidence}>
          {(confidence) => (
            <div
              style={{
                display: 'flex',
                'flex-direction': 'column',
                gap: '6px',
                'padding-top': '4px',
              }}
            >
              <span style={{ display: 'flex', gap: '8px', 'align-items': 'baseline' }}>
                <span style={sectionLabel}>Confidence</span>
                <span
                  style={{
                    'font-size': sf(10),
                    color: theme.fgMuted,
                    'font-style': props.stale ? 'italic' : undefined,
                  }}
                >
                  {confidence().source ? `${confidence().source} · ` : ''}
                  {formatRelativeAge(confidence().publishedAt, now())}
                  {props.stale ? ' · code changed since' : ''}
                </span>
              </span>
              <For each={confidence().scores}>
                {(score) => (
                  <div
                    style={{
                      display: 'grid',
                      'grid-template-columns': '84px 56px 36px minmax(0, 1fr)',
                      'column-gap': '8px',
                      'align-items': 'baseline',
                    }}
                  >
                    <span style={{ 'font-size': sf(11), color: theme.fg }}>{score.label}</span>
                    <span
                      aria-hidden="true"
                      style={{
                        height: '4px',
                        'align-self': 'center',
                        'border-radius': '2px',
                        background: theme.border,
                        overflow: 'hidden',
                      }}
                    >
                      <span
                        style={{
                          display: 'block',
                          height: '100%',
                          width: `${score.score}%`,
                          background:
                            !props.stale && score.score < LOW_SCORE ? theme.warning : theme.fgMuted,
                        }}
                      />
                    </span>
                    <span
                      style={{
                        'font-family': MONO,
                        'font-size': sf(11),
                        color: scoreColor(score.score, props.stale),
                      }}
                    >
                      {score.score}%
                    </span>
                    <span
                      style={{ 'font-size': sf(11), color: theme.fgMuted, 'line-height': '1.4' }}
                    >
                      {score.why}
                    </span>
                  </div>
                )}
              </For>
            </div>
          )}
        </Show>
      </div>

      <Show when={brief()}>
        {(b) => (
          <div
            style={{
              padding: '12px 16px',
              display: 'flex',
              'flex-direction': 'column',
              gap: '12px',
            }}
          >
            <Show when={b().changed.length}>
              <Section label="Changed">
                <ItemList items={b().changed} onFileClick={props.onFileClick} />
              </Section>
            </Show>
            <Show when={extra().length}>
              <Section label="Extra">
                <ItemList items={extra()} onFileClick={props.onFileClick} />
              </Section>
            </Show>
            <Show when={open().length}>
              <Section label="Open">
                <ItemList items={open()} onFileClick={props.onFileClick} />
              </Section>
            </Show>
            <Show when={b().decided.length}>
              <Section label="Decided">
                <ul
                  style={{
                    'list-style': 'none',
                    margin: '0',
                    padding: '0',
                    display: 'flex',
                    'flex-direction': 'column',
                    gap: '10px',
                  }}
                >
                  <For each={b().decided}>
                    {(item) => (
                      <DecisionRow
                        task={props.task}
                        item={item}
                        edit={decisionEdits()[item.text]}
                        setEdit={setDecisionEdit}
                      />
                    )}
                  </For>
                </ul>
              </Section>
            </Show>
          </div>
        )}
      </Show>

      <Show when={showTurns() && props.task.brief?.turns.length}>
        <div
          style={{
            margin: '0 16px',
            padding: '10px 0',
            'border-top': `1px solid ${theme.borderSubtle}`,
            display: 'flex',
            'flex-direction': 'column',
            gap: '8px',
          }}
        >
          <For each={[...(props.task.brief?.turns ?? [])].reverse()}>
            {(turn) => (
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
                <span style={{ 'font-size': sf(11), color: theme.fg, 'line-height': '1.4' }}>
                  {turn.prompt ? `“${turn.prompt}”` : 'Turn'}
                </span>
                <span style={{ 'font-size': sf(11), color: theme.fgMuted, 'line-height': '1.4' }}>
                  {turn.outcome}
                  {turn.endedAt ? ` · ${formatRelativeAge(turn.endedAt, now())}` : ''}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>

      <div
        style={{
          padding: '8px 16px 10px',
          'border-top': `1px solid ${theme.borderSubtle}`,
          display: 'flex',
          'flex-wrap': 'wrap',
          gap: '12px',
          'align-items': 'center',
        }}
      >
        <span style={{ 'font-size': sf(10), color: theme.fgMuted, flex: '1', 'min-width': '0' }}>
          {props.task.briefStatus?.state === 'generating'
            ? 'Updating…'
            : props.task.brief
              ? `Updated ${formatRelativeAge(props.task.brief.generatedAt, now())}`
              : ''}
        </span>
        <Show when={props.task.brief?.turns.length}>
          <button
            type="button"
            style={linkButton}
            aria-expanded={showTurns()}
            onClick={() => setShowTurns((v) => !v)}
          >
            {showTurns() ? 'Hide turns' : `Turns (${props.task.brief?.turns.length ?? 0})`}
          </button>
        </Show>
        <Show when={store.taskBriefs}>
          <button
            type="button"
            style={linkButton}
            disabled={props.task.briefStatus?.state === 'generating'}
            onClick={() => void refreshTaskBrief(props.task.id, { force: true })}
          >
            Update now
          </button>
        </Show>
        <button type="button" style={linkButton} disabled={rating()} onClick={() => void rate()}>
          {props.task.confidence ? 'Re-rate confidence' : 'Rate confidence'}
        </button>
        <Show when={props.onWalkThrough}>
          <button
            type="button"
            style={linkButton}
            disabled={props.walkThroughDisabled}
            onClick={() => props.onWalkThrough?.()}
          >
            Walk me through
          </button>
        </Show>
      </div>
    </div>
  );
}

/** One quiet line for the sidebar row: the brief's headline. */
export function TaskBriefLine(props: { task: Task }) {
  return (
    <Show when={props.task.brief?.brief.headline}>
      {(headline) => (
        <div
          class="task-brief-line"
          title={headline()}
          style={{
            color: theme.fgSubtle,
            'font-size': sf(10),
            'line-height': '1.4',
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
            'white-space': 'nowrap',
            'min-width': '0',
          }}
        >
          {headline()}
        </div>
      )}
    </Show>
  );
}
