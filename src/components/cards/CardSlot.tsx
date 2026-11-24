import { For, Show, createSignal, onCleanup, type JSX } from 'solid-js';
import type { ChecklistState, SlotDefinition, SlotValue, StatusState } from '../../lib/card-slots';
import { isEmptyList, slotWarns } from '../../lib/card-display';
import { ConfidenceScores } from './ConfidenceScores';
import { errMessage, warn as logWarn } from '../../lib/log';
import { createFlashOnChange } from './flash';

/** A running row spins instead, as the card's head does while it runs. */
const STATUS_MARK: Record<Exclude<StatusState, 'running'>, string> = {
  ok: '✓',
  warn: '!',
  fail: '✕',
  unknown: '?',
};
const CHECKLIST_MARK: Record<ChecklistState, string> = { done: '✓', current: '▸', todo: '·' };
/** Add-up lists show the newest few; the rest sit behind "+ N earlier". */
const ADD_UP_SHOWN = 4;

function Meter(props: { percent: number; tick?: number }) {
  const clamp = (value: number) => Math.max(0, Math.min(100, value));
  return (
    <div class="slot-meter" aria-hidden="true">
      <div class="slot-meter-fill" style={{ width: `${clamp(props.percent)}%` }} />
      <Show when={props.tick !== undefined}>
        <div class="slot-meter-tick" style={{ left: `${clamp(props.tick ?? 0)}%` }} />
      </Show>
    </div>
  );
}

function TextBlock(props: { text: string }) {
  const [copied, setCopied] = createSignal(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(copiedTimer));
  const copy = () => {
    navigator.clipboard.writeText(props.text).then(
      () => {
        setCopied(true);
        clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => setCopied(false), 2000);
      },
      (error: unknown) => logWarn('cards', 'Copy failed', { error: errMessage(error) }),
    );
  };
  return (
    <>
      <pre class="slot-text">{props.text}</pre>
      <div>
        <button type="button" class="cards-btn btn-secondary slot-copy" onClick={copy}>
          {copied() ? 'Copied' : 'Copy'}
        </button>
      </div>
    </>
  );
}

function ItemsList(props: { value: Extract<SlotValue, { type: 'items' }>; addUp?: boolean }) {
  const [all, setAll] = createSignal(false);
  const shown = () =>
    props.addUp && !all() ? props.value.items.slice(0, ADD_UP_SHOWN) : props.value.items;
  const hidden = () => props.value.items.length - shown().length;
  return (
    <ul class="slot-list">
      <For each={shown()}>
        {(item) => (
          <li data-severity={item.severity}>
            <span class="slot-mark">{item.severity === 'info' ? '·' : '!'}</span>
            <span class="slot-row-text">
              {item.text}
              {/* Below the text at full width: beside it, a long path lost its file name. */}
              <Show when={item.file}>
                <span class="slot-item-file">{item.file}</span>
              </Show>
              <Show when={item.detail}>
                <span class="slot-item-detail">{item.detail}</span>
              </Show>
            </span>
            <Show when={item.tag ?? (!item.file && item.turn !== undefined && `turn ${item.turn}`)}>
              {(tag) => <span class="slot-item-tag">{tag()}</span>}
            </Show>
          </li>
        )}
      </For>
      <Show when={props.addUp && props.value.items.length > ADD_UP_SHOWN}>
        <li>
          <button type="button" class="cards-btn btn-secondary" onClick={() => setAll(!all())}>
            {all() ? 'Show fewer' : `+ ${hidden()} earlier`}
          </button>
        </li>
      </Show>
    </ul>
  );
}

/** Every step shows, the current one in full text: a checklist is read for where things stand. */
function Checklist(props: { value: Extract<SlotValue, { type: 'checklist' }> }) {
  const done = () => props.value.items.filter((item) => item.state === 'done').length;
  return (
    <>
      <div class="slot-progress">
        <Meter percent={(done() / props.value.items.length) * 100} />
        <span class="slot-progress-count">
          {done()}/{props.value.items.length}
        </span>
      </div>
      <ul class="slot-list">
        <For each={props.value.items}>
          {(item) => (
            <li data-state={item.state}>
              <span class="slot-mark">{CHECKLIST_MARK[item.state]}</span>
              <span class="slot-row-text">{item.text}</span>
            </li>
          )}
        </For>
      </ul>
    </>
  );
}

function StatusRows(props: { value: Extract<SlotValue, { type: 'status' }> }) {
  return (
    <ul class="slot-list">
      <For each={props.value.rows}>
        {(row) => (
          <li data-state={row.state}>
            <span class="slot-mark">
              <Show
                when={row.state !== 'running' && row.state}
                fallback={<span class="status-glyph-spinner card-spinner" aria-hidden="true" />}
              >
                {(state) => STATUS_MARK[state()]}
              </Show>
            </span>
            <span class="slot-row-text">{row.text}</span>
            <Show when={row.value}>
              <span class="slot-row-value">{row.value}</span>
            </Show>
          </li>
        )}
      </For>
    </ul>
  );
}

function BigNumber(props: { value: number; unit?: string }) {
  return (
    <span class="slot-number">
      <span class="slot-number-value">{props.value}</span>
      <Show when={props.unit}>
        <span class="slot-number-unit">{props.unit}</span>
      </Show>
    </span>
  );
}

/** Called inside a keyed Show, so it rebuilds whenever the value is replaced. */
function slotBody(slot: SlotDefinition, value: SlotValue): JSX.Element {
  switch (value.type) {
    case 'line':
      return <p class="slot-line">{value.text}</p>;
    case 'text':
      return <TextBlock text={value.text} />;
    case 'score':
      return (
        <>
          <BigNumber value={value.score} />
          <Meter percent={value.score} tick={slot.warnBelow} />
          <Show when={value.why}>
            <span class="slot-why">{value.why}</span>
          </Show>
        </>
      );
    case 'scores':
      return <ConfidenceScores scores={value.scores} warnBelow={slot.warnBelow} />;
    case 'stat': {
      const limit = value.limit ?? slot.limit;
      return (
        <>
          <BigNumber value={value.value} unit={value.unit} />
          <Show when={limit}>{(max) => <Meter percent={(value.value / max()) * 100} />}</Show>
        </>
      );
    }
    case 'items':
      return <ItemsList value={value} addUp={slot.addUp} />;
    case 'checklist':
      return <Checklist value={value} />;
    case 'status':
      return <StatusRows value={value} />;
  }
}

interface CardSlotProps {
  slot: SlotDefinition;
  value: SlotValue | undefined;
  /** False where the card's name already says it; see `showsSlotLabel`. */
  showLabel?: boolean;
}

/** One slot with its label; the final layout with a placeholder while it has no value. */
export function CardSlot(props: CardSlotProps) {
  const warn = () => !!props.value && slotWarns(props.slot, props.value);
  let el: HTMLDivElement | undefined;
  // A run often returns the same value again; only a different one is news.
  createFlashOnChange(
    () => el,
    () => (props.value ? JSON.stringify(props.value) : ''),
  );
  return (
    <div
      ref={el}
      class="slot"
      data-type={props.slot.type}
      data-slot-id={props.slot.id}
      data-warn={warn() ? '' : undefined}
    >
      <Show when={props.showLabel ?? true}>
        <span class="slot-label">{props.slot.label}</span>
      </Show>
      {/* Keyed: a run replaces the whole value, so the body is rebuilt from it. */}
      <Show
        when={props.value}
        keyed
        fallback={
          // A dash reads as "no value" only under a label; alone in a card it is just a mark.
          <Show when={props.showLabel ?? true} fallback={<p class="card-empty">Nothing yet</p>}>
            <span class="slot-placeholder">–</span>
          </Show>
        }
      >
        {(value) =>
          isEmptyList(value) ? <p class="card-empty">None</p> : slotBody(props.slot, value)
        }
      </Show>
    </div>
  );
}
