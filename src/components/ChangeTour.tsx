import { Show, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import type { ChangeTourController } from '../lib/create-change-tour';
import { stopToCard, type TourLocation } from '../lib/change-tour';
import { errMessage, warn as logWarn } from '../lib/log';
import { openFileInEditor } from '../lib/shell';
import { TOUR_KEYS, isTypingTarget } from '../lib/tour-keys';
import { tourMarkdown } from '../lib/tour-markdown';
import type { TourRef } from '../lib/understanding-tour';
import { store } from '../store/store';
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  ListIcon,
  PencilIcon,
  SyncIcon,
} from './icons';
import { TourAskBar } from './understanding/TourAskBar';
import { TourCard } from './understanding/TourCard';
import { TourCopyButton } from './understanding/TourCopyButton';
import { TourIconButton } from './understanding/TourIconButton';
import { TourOverview } from './understanding/TourOverview';
import { TourProgress } from './understanding/TourProgress';
import { TourReworkBar } from './understanding/TourReworkBar';
import { TourThreads } from './understanding/TourThreads';

/**
 * The change tour beside the diff: one stop at a time as a tour card, with the
 * follow-ups asked under it. Closing the reader preserves the generated tour.
 */
export function ChangeTour(props: {
  tour: ChangeTourController;
  onNavigate: (location: TourLocation) => void;
  onFinish: () => void;
  worktreePath: string;
}) {
  const cards = createMemo(() => props.tour.stops().map(stopToCard));
  const card = () => cards()[props.tour.step()];
  const isLastStep = () => props.tour.step() === cards().length - 1;
  const answered = () => new Set(props.tour.threads().map((thread) => thread.fromIndex));
  const [reworking, setReworking] = createSignal(false);
  const [overview, setOverview] = createSignal(false);
  let sectionRef: HTMLElement | undefined;
  let contentRef: HTMLDivElement | undefined;

  createEffect(() => {
    const location = props.tour.stops()[props.tour.step()]?.locations[0];
    if (contentRef) contentRef.scrollTop = 0;
    if (location) props.onNavigate(location);
  });

  // Moving to a card, from the overview or otherwise, shows that card.
  createEffect(
    on(
      () => props.tour.step(),
      () => setOverview(false),
      { defer: true },
    ),
  );

  // Arrow keys also scroll the diff, so they move the tour only while focus is
  // inside it — after a click on a stop's ref or control.
  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const move = TOUR_KEYS[event.key];
      if (!move || isTypingTarget(event.target) || !cards().length) return;
      if (!(event.target instanceof Node) || !sectionRef?.contains(event.target)) return;
      event.preventDefault();
      props.tour.navigate(move(props.tour.step(), cards().length - 1));
    };
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => document.removeEventListener('keydown', onKeyDown));
  });

  /** Refs into the diff scroll it; anything else, such as an answer's ref, opens the editor. */
  function openRef(ref: TourRef): void {
    const inDiff = props.tour.files().some((file) => file.path === ref.filePath);
    if (inDiff && ref.line !== undefined) {
      props.onNavigate({ ...ref, line: ref.line });
      return;
    }
    const at = { line: ref.line, editorCommand: store.editorCommand.trim() };
    void openFileInEditor(props.worktreePath, ref.filePath, at).catch((error) =>
      logWarn('changeTour', 'Could not open reference', { error: errMessage(error) }),
    );
  }

  function markdown(): string {
    return tourMarkdown({
      title: `Change tour: ${props.tour.taskName()}`,
      cards: cards(),
      threads: props.tour.threads(),
    });
  }

  return (
    <section ref={sectionRef} class="change-tour" aria-label="Guided change tour">
      <div class="change-tour-top">
        <Show
          when={!props.tour.loading() && card()}
          fallback={<span class="understanding-footer-fill" />}
        >
          <TourProgress
            subject="Tour"
            titles={cards().map((entry) => entry.title)}
            current={props.tour.step()}
            onSelect={(index) => props.tour.navigate(index)}
            answered={answered()}
          />
          <TourIconButton
            label={overview() ? 'Hide overview' : 'Show overview'}
            tooltip="All cards at a glance"
            onClick={() => setOverview((open) => !open)}
          >
            <ListIcon size={14} />
          </TourIconButton>
          <TourCopyButton markdown={markdown} />
          <TourIconButton
            label="Rework tour"
            tooltip="Rework tour with your own instructions"
            onClick={() => setReworking((open) => !open)}
          >
            <PencilIcon size={14} />
          </TourIconButton>
        </Show>
      </div>

      <Show when={reworking() && !props.tour.loading() && card()}>
        <TourReworkBar
          onSubmit={(instructions) => {
            setReworking(false);
            props.tour.rework(instructions);
          }}
          onCancel={() => setReworking(false)}
        />
      </Show>

      <Show when={props.tour.loading()}>
        <div class="change-tour-message">
          <p class="understanding-status">
            <span class="inline-spinner" aria-hidden="true" />
            {props.tour.progress()}
          </p>
          <p class="understanding-substatus">
            {props.tour.receiving() ? 'Receiving response' : 'Waiting for provider'} ·{' '}
            {props.tour.elapsedSeconds()}s
          </p>
          <TourIconButton label="Cancel generation" onClick={() => props.tour.cancel()}>
            <CloseIcon size={14} />
          </TourIconButton>
        </div>
      </Show>

      <Show when={!props.tour.loading() && !card() && props.tour.error()}>
        {(message) => (
          <div class="change-tour-message">
            <p role="alert" class="understanding-alert">
              {message()}
            </p>
            <button class="review-control btn-with-icon" onClick={() => props.tour.retry()}>
              <SyncIcon size={12} />
              Retry
            </button>
          </div>
        )}
      </Show>

      <Show when={!props.tour.loading() && card()}>
        {(current) => (
          <>
            <div ref={contentRef} class="change-tour-stage">
              <Show
                when={overview()}
                fallback={
                  <>
                    <TourCard
                      card={current()}
                      onOpenRef={openRef}
                      onAsk={(question) => props.tour.ask(question)}
                      asking={props.tour.asking()}
                      answeredQuestions={props.tour
                        .threadsFor(props.tour.step())
                        .map((thread) => thread.question)}
                    />
                    <TourThreads
                      threads={props.tour.threadsFor(props.tour.step())}
                      pendingQuestion={props.tour.pendingQuestion()}
                      onOpenRef={openRef}
                    />
                  </>
                }
              >
                <TourOverview
                  cards={cards()}
                  current={props.tour.step()}
                  onSelect={(index) => {
                    setOverview(false);
                    props.tour.navigate(index);
                  }}
                />
              </Show>
              <Show when={props.tour.omittedFileCount() > 0}>
                <p class="change-tour-note">
                  {props.tour.omittedFileCount()} files are outside this tour. Use “Show all
                  changes” to review them.
                </p>
              </Show>
            </div>
            <Show when={props.tour.askError()}>
              {(message) => (
                <p role="alert" class="understanding-alert change-tour-ask-error">
                  {message()}
                </p>
              )}
            </Show>
            <div class="change-tour-ask">
              <TourAskBar
                disabled={props.tour.asking()}
                asking={props.tour.pendingQuestion() !== ''}
                onAsk={(question) => props.tour.ask(question)}
                onGoDeeper={() => props.tour.goDeeper()}
                onCancel={() => props.tour.cancelAsk()}
              />
            </div>
            <div class="change-tour-nav">
              <button
                class="review-control btn-with-icon"
                disabled={props.tour.step() === 0}
                onClick={() => props.tour.navigate(props.tour.step() - 1)}
              >
                <ChevronLeftIcon size={12} />
                Previous
              </button>
              <button
                class="review-control change-tour-next btn-with-icon"
                title="Arrow keys navigate while the tour has focus"
                onClick={() => {
                  if (isLastStep()) props.onFinish();
                  else props.tour.navigate(props.tour.step() + 1);
                }}
              >
                {isLastStep() ? 'Finish tour' : 'Next'}
                {isLastStep() ? <CheckIcon size={12} /> : <ChevronRightIcon size={12} />}
              </button>
            </div>
          </>
        )}
      </Show>
    </section>
  );
}
