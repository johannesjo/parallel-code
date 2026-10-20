import { For, Show, createEffect, createSignal, createUniqueId, on, onCleanup } from 'solid-js';
import { Dialog } from './Dialog';
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  GitGraphIcon,
  ListIcon,
  MentionIcon,
  PencilIcon,
  RedoIcon,
  SyncIcon,
} from './icons';
import { createHeightTransition } from './understanding/create-height-transition';
import { TourAskBar } from './understanding/TourAskBar';
import { TourCard } from './understanding/TourCard';
import { TourCopyButton } from './understanding/TourCopyButton';
import { TourDeeper, questionLabel } from './understanding/TourDeeper';
import { TourIconButton } from './understanding/TourIconButton';
import { TourNotes } from './understanding/TourNotes';
import { TourOutline } from './understanding/TourOutline';
import { TourProgress } from './understanding/TourProgress';
import { TourReworkBar } from './understanding/TourReworkBar';
import { TourSaveState } from './understanding/TourSaveState';
import { createThinkingControls } from './thinking/create-thinking-controls';
import { ThinkingFooter } from './thinking/ThinkingFooter';
import { altAction } from './thinking/ThinkingCard';
import { ThinkingMap } from './thinking/ThinkingMap';
import { ThinkingStep } from './thinking/ThinkingStep';
import { cardReference, notesReference, serializeTour } from '../lib/tour-file';
import { belowNodeId, findNode, questionPoint, rootIndexOf } from '../lib/tour-tree';
import type { TourNode } from '../lib/tour-tree';
import type { UnderstandingTourController } from '../lib/create-understanding-tour';
import type { TourRef } from '../lib/understanding-tour';
import { errMessage, warn as logWarn } from '../lib/log';
import { openFileInEditor } from '../lib/shell';
import { isTypingTarget } from '../lib/tour-keys';
import { store } from '../store/store';

/** The panel is only a layout box here: the card inside it is the one surface. */
const PANEL_STYLE = {
  width: 'auto',
  padding: '0',
  gap: '0',
  background: 'transparent',
  border: 'none',
  'box-shadow': 'none',
  overflow: 'hidden',
} as const;

/** The mind map shows the whole tree, so it may take the window less a margin. */
const MAP_PANEL_STYLE = {
  ...PANEL_STYLE,
  height: 'calc(100vh - 32px)',
  'max-height': 'none',
} as const;

/** Reading one card is the whole task, so the rest of the app goes dark. */
const OVERLAY_STYLE = {
  background: 'rgba(0,0,0,0.78)',
  'backdrop-filter': 'blur(6px) saturate(1.1)',
} as const;

/** Three lines standing in for the card that is still generating. */
const SKELETON_WIDTHS = ['100%', '92%', '64%'];

/** Controls that Enter presses itself rather than leaving to the tour. */
const CONTROLS = 'button, a[href], summary, select, [role="button"]';

/**
 * Viewer for a generated understanding tour: one card at a time, with the
 * tour's outline beside it when the window has room. Answers to the reader's
 * questions become cards under the card they were asked on.
 */
export function UnderstandingTourDialog(props: {
  tour: UnderstandingTourController;
  open: boolean;
  onClose: () => void;
  worktreePath: string;
  /** Raised above another open dialog, e.g. when started from the plan viewer. */
  zIndex?: number;
  /** Hands the card on screen to the task's agent chat; absent where there is none. */
  onReference?: (reference: string) => void;
  /** Shows a saved tour's file on the canvas; absent where there is no canvas. */
  onOpenFile?: (path: string) => void;
}) {
  const headingId = createUniqueId();
  /** The action the reader is most likely to press next; see the focus effect. */
  let primaryRef: HTMLButtonElement | undefined;
  let askRef: HTMLInputElement | undefined;
  /** Holds the card on screen, which the arrow keys scroll. */
  let stageRef: HTMLDivElement | undefined;
  let settleStage: (() => void) | undefined;
  const controller = () => props.tour;
  const tour = () => props.tour.tour();
  const roots = () => props.tour.tree();
  const node = () => props.tour.currentNode();
  const parent = () => props.tour.trail().at(-2);
  const onLastCard = () => !props.tour.hasNext();
  /** Tour cards with answers under them, for the progress markers. */
  const answered = () =>
    new Set(roots().flatMap((root, index) => (root.children.length > 0 ? [index] : [])));
  const [reworking, setReworking] = createSignal(false);
  const [overview, setOverview] = createSignal(false);
  // Kept outside the dialog's contents, so closing the tour or moving to
  // another one keeps what the reader wrote until they send it.
  // shortcut: in memory per task panel — persist with the task if notes must survive a restart
  const [notes, setNotes] = createSignal('');
  /** The tour the notes were started on, which the reader may since have left. */
  let notesSubject = '';
  /** The finished tour on screen, when there is one to copy or rework. */
  const shownTour = () => (props.tour.loading() ? null : tour());
  let dialogRef: HTMLDivElement | undefined;
  const thinking = createThinkingControls({
    tour: () => props.tour,
    worktreePath: () => props.worktreePath,
    onDone: () => queueMicrotask(() => primaryRef?.focus()),
    onClose: () => props.onClose(),
  });

  function markdown(): string {
    const shown = tour();
    return serializeTour(
      {
        subject: props.tour.subject(),
        kind: props.tour.thinking() ? 'thinking' : (shown?.kind ?? 'agent'),
        omitted: shown?.omitted,
        roots: roots(),
      },
      { forFile: false },
    );
  }

  function reference(): void {
    const text = cardReference({
      subject: props.tour.subject(),
      savedPath: props.tour.savedPath() || undefined,
      trail: props.tour.trail(),
    });
    if (text) props.onReference?.(text);
  }

  function editNotes(value: string): void {
    if (!notes().trim()) notesSubject = props.tour.subject();
    setNotes(value);
  }

  function sendNotes(): void {
    // The saved file only belongs to the notes while their tour is the one open.
    const sameTour = notesSubject === props.tour.subject();
    const text = notesReference({
      subject: notesSubject,
      savedPath: (sameTour && props.tour.savedPath()) || undefined,
      notes: notes(),
    });
    if (!text) return;
    props.onReference?.(text);
    setNotes('');
  }

  /** The outline with the reader's notes under it, wherever the outline shows. */
  function sidePanel() {
    return (
      <>
        <div class="understanding-aside-outline">{outline()}</div>
        <TourNotes
          value={notes()}
          onInput={editNotes}
          onSend={props.onReference ? sendNotes : undefined}
        />
      </>
    );
  }

  /**
   * Why the ask field is closed: a question still being answered on another
   * card, or a tour that can hold no deeper answer here. Undefined when open.
   */
  function askPlaceholder(): string | undefined {
    const inFlight = props.tour.pending();
    if (inFlight && inFlight.nodeId !== props.tour.currentId()) {
      const asked = findNode(roots(), inFlight.nodeId);
      return asked ? `Answering on “${asked.card.title}”…` : undefined;
    }
    const limit = props.tour.askLimit();
    if (!limit) return undefined;
    const reason = {
      depth: 'Deepest level reached',
      cards: 'This tour is full',
      size: 'Another answer could exceed the tour file size limit',
    }[limit];
    return props.onReference ? `${reason} · continue in chat` : reason;
  }

  /**
   * Where the answer on screen sits among the answers to the same question,
   * e.g. "Answer 2 of 3", matching the question the line above it names.
   */
  function answerPosition(): string {
    const question = node()?.question;
    const siblings = (parent()?.children ?? []).filter((child) => child.question === question);
    const index = siblings.findIndex((child) => child.id === props.tour.currentId());
    return index < 0 ? '' : `Answer ${index + 1} of ${siblings.length}`;
  }

  function rework(instructions: string): void {
    setReworking(false);
    controller().rework(instructions);
  }

  // Give the primary action focus as soon as a tour is on screen, so the arrow
  // keys move on and Enter opens the ask field without reaching for the pointer.
  createEffect(() => {
    if (props.open && tour() && !props.tour.loading() && !thinking.editing()) primaryRef?.focus();
  });

  // Moving to a card, from the overview or otherwise, shows that card. A
  // control inside the old card that had focus is gone with it, so focus
  // returns to the way forward rather than dropping to the page.
  createEffect(
    on(
      () => props.tour.currentId(),
      () => {
        setOverview(false);
        if (props.open) queueMicrotask(refocus);
      },
      { defer: true },
    ),
  );

  function refocus(): void {
    const active = document.activeElement;
    if (!active || active === document.body) primaryRef?.focus();
  }

  function openRef(ref: TourRef): void {
    const at = { line: ref.line, editorCommand: store.editorCommand.trim() };
    void openFileInEditor(props.worktreePath, ref.filePath, at).catch((error) =>
      logWarn('understandingTour', 'Could not open reference', { error: errMessage(error) }),
    );
  }

  /** Digs into one point, or opens the answer it already has. */
  function onPoint(point: string): void {
    const answer = node()?.children.find((child) => questionPoint(child.question) === point);
    if (answer) controller().select(answer.id);
    else controller().goDeeperOn(point);
  }

  function hasPointAnswer(item: TourNode, point: string): boolean {
    return item.children.some((child) => questionPoint(child.question) === point);
  }

  /** The card on screen, among the cards of its step. */
  function currentCard(): HTMLElement | null | undefined {
    return stageRef?.querySelector<HTMLElement>('[aria-current="true"] > article');
  }

  /**
   * Scrolls a long card by one step; false when it is already at that end. A
   * card alone scrolls itself; in a stack the stack scrolls, card by card.
   */
  function scrollCard(direction: 1 | -1): boolean {
    // Mid-ease the card is shorter than it will be, so it would seem to scroll.
    settleStage?.();
    const card = currentCard();
    const stack = card?.closest<HTMLElement>('.understanding-stack');
    if (!card || !stack) return false;
    const box = card.scrollHeight > card.clientHeight ? card : stack;
    const cardRect = card.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    // A card that fits is centred by the step itself; paging it here would
    // cancel that slide when keys come quickly, and stall instead of moving on.
    if (box === stack && cardRect.height <= boxRect.height) return false;
    const room =
      box === card
        ? direction > 0
          ? card.scrollHeight - card.clientHeight - card.scrollTop
          : card.scrollTop
        : direction > 0
          ? cardRect.bottom - boxRect.bottom
          : boxRect.top - cardRect.top;
    if (room <= 1) return false;
    box.scrollBy({ top: direction * Math.min(room, 64) });
    return true;
  }

  /** Moves to the tour card before or after the one being read. */
  function stepTour(direction: 1 | -1): void {
    const index = rootIndexOf(roots(), props.tour.currentId());
    controller().navigate(index + direction);
  }

  /**
   * Left and right go between the tour's own cards. Down reads on through the
   * answers under one tour card, into each card's answers first, and then
   * goes to the ask field; up steps back to the answer above or out to the
   * card answered. Both scroll a long card to its end first. Returns whether
   * the key did anything.
   */
  function move(key: string): boolean {
    switch (key) {
      case 'ArrowLeft':
        stepTour(-1);
        return true;
      case 'ArrowRight':
        stepTour(1);
        return true;
      case 'ArrowDown': {
        if (scrollCard(1)) return true;
        const below = belowNodeId(roots(), props.tour.currentId());
        if (!below) return focusAskField();
        controller().select(below);
        return true;
      }
      case 'ArrowUp':
        if (scrollCard(-1)) return true;
        if (!parent()) return false;
        controller().previous();
        return true;
      case 'Home':
        controller().navigate(0);
        return true;
      case 'End':
        controller().navigate(roots().length - 1);
        return true;
      default:
        return false;
    }
  }

  /**
   * Enter from the resting focus, Next or the card itself, goes to the ask
   * field; on any other control it keeps pressing that control.
   */
  function focusAsk(target: EventTarget | null): boolean {
    const onControl = target instanceof Element && target.closest(CONTROLS) !== null;
    if (onControl && target !== primaryRef) return false;
    return focusAskField();
  }

  function focusAskField(): boolean {
    if (!askRef || askRef.disabled) return false;
    askRef.focus();
    return true;
  }

  const inMenu = (target: EventTarget | null) =>
    target instanceof Element && target.closest('[role="menu"]') !== null;

  /**
   * Never while typing: the keys move the caret there. Nor under another
   * dialog, such as a thinking tour opened over a task's tour: only the
   * topmost panel is marked modal. Nor in a menu opened from the tour, such
   * as the model menu, which walks its own items with the arrows.
   */
  function onKeyDown(event: KeyboardEvent): void {
    if (isTypingTarget(event.target) || inMenu(event.target) || !tour()) return;
    if (!dialogRef?.closest('[aria-modal="true"]')) return;
    const handled = props.tour.thinking()
      ? thinkingKey(event)
      : event.key === 'Enter'
        ? focusAsk(event.target)
        : move(event.key);
    if (handled) event.preventDefault();
  }

  /**
   * Reading a tour the reader writes: the arrows move as in any tour, Enter
   * starts typing on the card and Ctrl+M switches to the mind map, whose own
   * keys are left alone while it is open.
   */
  function thinkingKey(event: KeyboardEvent): boolean {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.shiftKey && event.key.toLowerCase() === 'm') {
      thinking.toggleMap();
      return true;
    }
    if (thinking.map()) return false;
    const alt = altAction(event);
    if (alt) {
      thinking.act(alt);
      return true;
    }
    if (mod || event.altKey) return false;
    // Space keeps pressing the control it is on; any other character is writing.
    if (event.key.length === 1 && event.key !== ' ') {
      thinking.typeKey(event.key);
      return true;
    }
    if (event.key !== 'Enter') return move(event.key);
    const onControl = event.target instanceof Element && event.target.closest(CONTROLS) !== null;
    if (onControl && event.target !== primaryRef) return false;
    thinking.startEditing();
    return true;
  }

  // Reading means clicking on the card, which hands focus to the dialog panel
  // rather than to a control inside it, so the keys are listened for on the
  // document instead of on this component.
  createEffect(() => {
    if (!props.open) return;
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => document.removeEventListener('keydown', onKeyDown));
  });

  /** A fresh outline per tour, so branches opened in one never open in the next. */
  function outline() {
    return (
      <Show when={tour()} keyed>
        {(_shown) => (
          <TourOutline
            roots={roots()}
            currentId={props.tour.currentId()}
            pending={props.tour.pending()}
            onSelect={(id) => controller().select(id)}
          />
        )}
      </Show>
    );
  }

  /**
   * The cards read together: the card whose answers are being read, then
   * those answers. A tour card without answers stands alone.
   */
  const step = () => {
    const head = parent() ?? node();
    return head ? [head, ...head.children] : [];
  };

  // The card moved to slides to the middle of the stack, or to its top when it
  // is taller than the stack, so the cards around it stay in view.
  createEffect(
    on(
      () => props.tour.currentId(),
      () => {
        const card = currentCard();
        const stack = card?.closest<HTMLElement>('.understanding-stack');
        if (!card || !stack || stack.childElementCount < 2) return;
        const cardRect = card.getBoundingClientRect();
        const stackRect = stack.getBoundingClientRect();
        const offset = Math.max(0, (stackRect.height - cardRect.height) / 2);
        const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
        stack.scrollTo({
          top: stack.scrollTop + cardRect.top - stackRect.top - offset,
          behavior: reduced ? 'auto' : 'smooth',
        });
      },
    ),
  );

  /**
   * The card on screen with the cards of its step, under a line that is
   * always laid out, so a tour card and an answer start at the same height.
   * On an answer the line names the question and leads back to the card it
   * answers. Only the card on screen takes clicks; another opens on click.
   */
  function StepView() {
    const blocked = () => props.tour.asking() || !props.tour.canAsk();
    const head = () => step()[0];
    return (
      <Show when={node()}>
        {(current) => (
          <>
            <p class="understanding-crumb">
              <Show when={parent()}>
                {(above) => (
                  <button
                    type="button"
                    title={`Back to: ${above().card.title}`}
                    onClick={() => controller().leave()}
                  >
                    ↳ {questionLabel(current().question ?? '', above().card.title)}
                  </button>
                )}
              </Show>
              <span class="understanding-crumb-count">{answerPosition()}</span>
            </p>
            <div class="understanding-stack">
              <For each={step()}>
                {(item) => {
                  const shown = () => item.id === current().id;
                  return (
                    <div
                      class="understanding-stack-item"
                      aria-current={shown() ? 'true' : undefined}
                      // An inert card passes its clicks to this wrapper; clicks
                      // inside the card on screen are its own.
                      onClick={(event) => {
                        if (event.target === event.currentTarget) controller().select(item.id);
                      }}
                    >
                      <TourCard
                        inert={!shown()}
                        card={item.card}
                        onOpenRef={openRef}
                        onAsk={(question) => void controller().ask(question)}
                        asking={blocked()}
                        answeredQuestions={item.children.flatMap((child) =>
                          child.question === undefined ? [] : [child.question],
                        )}
                        omitted={roots().at(-1)?.id === item.id ? tour()?.omitted : undefined}
                        points={{
                          open: (point) => hasPointAnswer(item, point),
                          disabled: blocked(),
                          onPoint,
                        }}
                        deeper={
                          <TourDeeper
                            // The head's answers are the cards below it; only a
                            // question still being answered is listed there.
                            answers={item === head() ? [] : item.children}
                            pendingQuestion={shown() ? props.tour.pendingQuestion() : ''}
                            parentTitle={item.card.title}
                            onSelect={(id) => controller().select(id)}
                          />
                        }
                      />
                    </div>
                  );
                }}
              </For>
            </div>
          </>
        )}
      </Show>
    );
  }

  function askBar() {
    return (
      <TourAskBar
        ref={(element) => (askRef = element)}
        onLeave={() => primaryRef?.focus()}
        disabled={props.tour.asking() || !props.tour.canAsk()}
        asking={props.tour.asking()}
        placeholder={askPlaceholder()}
        onContinueInChat={props.tour.askLimit() && props.onReference ? reference : undefined}
        onAsk={(question) => void controller().ask(question)}
        onGoDeeper={() => controller().goDeeper()}
        onCancel={() => controller().cancel()}
      />
    );
  }

  /** The card on screen in a tour the reader writes; see ThinkingStep. */
  function thinkingStep() {
    const proposal = () => {
      const waiting = thinking.writer.proposal();
      return waiting?.nodeId === props.tour.currentId() ? waiting : undefined;
    };
    // Keyed on the id, not the node: each keystroke makes a new node, and
    // remounting on it would send the caret back to the title.
    return (
      <Show when={props.tour.currentId()} keyed>
        {(id) => (
          <Show when={node()}>
            {(current) => (
              <ThinkingStep
                node={current()}
                parent={parent()}
                editing={thinking.editing()}
                focus={thinking.focus()}
                writing={thinking.writer.writingId() === id}
                proposal={proposal()}
                error={thinking.writer.error(id)}
                onChange={thinking.change}
                onAction={thinking.act}
                onEdit={thinking.startEditing}
                onLeave={() => controller().leave()}
                onAccept={thinking.accept}
                onReject={thinking.reject}
              />
            )}
          </Show>
        )}
      </Show>
    );
  }

  function thinkingMap() {
    return (
      <ThinkingMap subject={props.tour.subject()} roots={roots()} onChange={thinking.fromMap} />
    );
  }

  function closeButton() {
    return (
      <TourIconButton label="Close tour" tooltip="Close" onClick={() => props.onClose()}>
        <CloseIcon size={14} />
      </TourIconButton>
    );
  }

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      zIndex={props.zIndex}
      panelStyle={thinking.map() ? MAP_PANEL_STYLE : PANEL_STYLE}
      overlayStyle={OVERLAY_STYLE}
      labelledBy={headingId}
    >
      <div ref={dialogRef} class="understanding-dialog" data-map={thinking.map() ? '' : undefined}>
        <div class="understanding-main">
          {/* No visible header: the card carries every word the reader needs. The
              heading exists so the dialog still has an accessible name. */}
          <h1 id={headingId} class="dialog-sr-only">
            Understanding tour of {props.tour.subject()}
          </h1>

          <div class="understanding-top">
            <Show
              when={!props.tour.loading() && tour()}
              fallback={<span class="understanding-footer-fill" />}
            >
              <TourProgress
                subject={props.tour.subject()}
                titles={roots().map((root) => root.card.title)}
                current={props.tour.step()}
                onSelect={(index) => controller().navigate(index)}
                answered={answered()}
              />
            </Show>
            <Show when={shownTour()}>
              {/* The outline stands beside the card where the window has room;
                  this shows it in the card's place where it has not. */}
              <TourIconButton
                class="understanding-outline-toggle"
                label={overview() ? 'Hide outline' : 'Show outline'}
                tooltip="All cards at a glance"
                onClick={() => setOverview((open) => !open)}
              >
                <ListIcon size={14} />
              </TourIconButton>
              <TourCopyButton markdown={markdown} />
              <TourSaveState
                savedPath={props.tour.savedPath()}
                saving={props.tour.saving()}
                unsaved={props.tour.unsaved()}
                onSave={() => void controller().save()}
                onOpen={props.onOpenFile}
              />
              <Show when={props.onReference}>
                <TourIconButton
                  label="Reference in chat"
                  tooltip="Reference this card in the agent chat"
                  onClick={reference}
                >
                  <MentionIcon size={14} />
                </TourIconButton>
              </Show>
              {/* A tour reopened from its file is that file's record; a new
                  tour of its subject starts from the subject's Take Tour. */}
              <Show when={props.tour.thinking()}>
                <TourIconButton
                  label={thinking.map() ? 'Show cards' : 'Show mind map'}
                  tooltip={
                    thinking.map()
                      ? 'Back to the cards · Ctrl+M'
                      : 'See the tour as a mind map · Ctrl+M'
                  }
                  pressed={thinking.map()}
                  onClick={() => thinking.toggleMap()}
                >
                  <GitGraphIcon size={14} />
                </TourIconButton>
              </Show>
              <Show when={!props.tour.fromFile() && !props.tour.thinking()}>
                <TourIconButton
                  label="Rework tour"
                  tooltip="Rework tour with your own instructions"
                  onClick={() => setReworking((open) => !open)}
                >
                  <PencilIcon size={14} />
                </TourIconButton>
              </Show>
            </Show>
            {closeButton()}
          </div>

          <Show when={reworking() && shownTour() && !props.tour.fromFile()}>
            <TourReworkBar onSubmit={rework} onCancel={() => setReworking(false)} />
          </Show>

          <Show when={shownTour() && props.tour.stale()}>
            <div class="understanding-notice" role="status">
              <span>This file changed after the tour was made.</span>
              <Show when={!props.tour.fromFile()}>
                <button
                  type="button"
                  class="understanding-notice-action btn-with-icon"
                  onClick={() => controller().retry()}
                >
                  <SyncIcon size={12} />
                  Regenerate
                </button>
              </Show>
            </div>
          </Show>

          <Show when={props.tour.loading()}>
            <div class="understanding-stage" aria-busy="true">
              <div class="understanding-card understanding-card--message">
                <p class="understanding-status">
                  <span class="inline-spinner" aria-hidden="true" />
                  {props.tour.progress()}
                </p>
                <p role="status" class="understanding-substatus">
                  {props.tour.receiving() ? 'Receiving response' : 'Waiting for provider'} ·{' '}
                  {props.tour.elapsedSeconds()}s
                </p>
                <div class="understanding-skeleton" aria-hidden="true">
                  <For each={SKELETON_WIDTHS}>{(width) => <span style={{ width }} />}</For>
                </div>
              </div>
            </div>
            <div class="understanding-footer">
              <span class="understanding-footer-fill" />
              <TourIconButton
                label="Cancel generation"
                tooltip="Cancel generation"
                onClick={() => controller().cancel()}
              >
                <CloseIcon size={14} />
              </TourIconButton>
            </div>
          </Show>

          <Show when={!tour() && !props.tour.loading()}>
            <div class="understanding-stage understanding-stage--message">
              <div class="understanding-card understanding-card--message">
                <Show
                  when={props.tour.error()}
                  fallback={<p class="understanding-status">Generation cancelled.</p>}
                >
                  {(message) => (
                    <p role="alert" class="understanding-alert">
                      {message()}
                    </p>
                  )}
                </Show>
              </div>
            </div>
            {/* Cancelling was deliberate, so only a failure offers another attempt. */}
            <Show when={props.tour.error()}>
              <div class="understanding-footer">
                <span class="understanding-footer-fill" />
                <TourIconButton
                  primary
                  label="Retry"
                  tooltip="Retry"
                  onClick={() => controller().retry()}
                >
                  <RedoIcon />
                </TourIconButton>
              </div>
            </Show>
          </Show>

          {/* A failed follow-up keeps the tour on screen, so its message sits above the card. */}
          <Show when={tour() && !props.tour.loading() ? props.tour.error() : ''}>
            {(message) => (
              <div class="understanding-alert-row">
                <p role="alert" class="understanding-alert">
                  {message()}
                </p>
              </div>
            )}
          </Show>

          <Show when={!props.tour.loading() && node()}>
            {/* The outline replaces the card only where it has no room beside it,
                so widening the window with it open brings the card back. */}
            <div
              class="understanding-stage"
              data-overview={overview() ? '' : undefined}
              ref={(element) => {
                stageRef = element;
                settleStage = createHeightTransition(element);
              }}
            >
              {/* A fresh stack per step, so its cards open scrolled to the top
                  with their notes closed; the footer stays and keeps its focus. */}
              <Show
                when={props.tour.thinking()}
                fallback={
                  <Show when={step()[0]?.id} keyed>
                    {(_head) => <StepView />}
                  </Show>
                }
              >
                <Show when={!thinking.map()} fallback={thinkingMap()}>
                  {thinkingStep()}
                </Show>
              </Show>
              <Show when={overview()}>
                <div class="understanding-card understanding-outline-card">{sidePanel()}</div>
              </Show>
            </div>
            <div class="understanding-footer">
              <TourIconButton
                label="Previous card"
                tooltip="Previous card · ↑ ↓ go into and out of answers and the ask field"
                disabled={!props.tour.hasPrevious()}
                onClick={() => controller().previous()}
              >
                <ChevronLeftIcon />
              </TourIconButton>
              <Show when={props.tour.thinking()} fallback={askBar()}>
                <ThinkingFooter
                  editing={thinking.editing()}
                  map={thinking.map()}
                  writing={thinking.writer.writingId() !== ''}
                  onWrite={() => thinking.write()}
                />
              </Show>
              <TourIconButton
                primary
                ref={(element) => (primaryRef = element)}
                label={onLastCard() ? 'Finish tour' : 'Next card'}
                tooltip={onLastCard() ? 'Finish' : 'Next card · Arrow keys navigate'}
                onClick={() => (onLastCard() ? props.onClose() : controller().next())}
              >
                <Show when={onLastCard()} fallback={<ChevronRightIcon />}>
                  <CheckIcon />
                </Show>
              </TourIconButton>
            </div>
          </Show>
        </div>

        <Show when={!props.tour.loading() && node()}>
          <aside class="understanding-aside">{sidePanel()}</aside>
        </Show>
      </div>
    </Dialog>
  );
}
