import { Show, createSignal, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { PlanStep } from '../../electron/shared/agent-plan';
import { createAnchorEffect, placeBelow } from '../lib/floating';
import { taskGoal } from '../lib/task-plan';
import { taskPlanView } from '../store/task-plan';
import { TaskContext, type TaskContextProps } from './TaskContext';

const POPOVER_WIDTH = 440;

/** The step to name in one line: the one in progress, else the next one to do, else the last. */
export function currentPlanStep(steps: PlanStep[]): string {
  const step =
    steps.find((s) => s.status === 'in_progress') ??
    steps.find((s) => s.status === 'pending') ??
    steps.at(-1);
  return step?.step ?? '';
}

/** Open while the popover shows; closes on Escape or a click outside it. */
function createPopover(
  anchor: () => HTMLElement | undefined,
  panel: () => HTMLElement | undefined,
) {
  const [open, setOpen] = createSignal(false);
  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as Node | null;
    if (target && (panel()?.contains(target) || anchor()?.contains(target))) return;
    setShown(false);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    setShown(false);
    anchor()?.focus();
  };
  // Listeners live only while open: a leftover keydown listener would swallow
  // Escape everywhere, terminals included.
  const setShown = (next: boolean) => {
    if (next === open()) return;
    setOpen(next);
    if (next) {
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('keydown', onKeyDown, true);
      // Keyboard users land on the popover's controls.
      queueMicrotask(() => panel()?.querySelector<HTMLElement>('button')?.focus());
    } else {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    }
  };
  onCleanup(() => setShown(false));
  return { open, setShown };
}

/**
 * The stacked task view's context: one line under the title naming the plan's
 * progress and current step (or the goal, before there is a plan), opening the
 * full context in a popover. Keeps one fixed height so the terminal never moves.
 */
export function TaskContextStrip(props: TaskContextProps) {
  let anchor: HTMLButtonElement | undefined;
  let panel: HTMLDivElement | undefined;
  const popover = createPopover(
    () => anchor,
    () => panel,
  );
  const [place, setPlace] = createSignal({ top: 0, right: 0, maxHeight: 400 });
  const width = () => Math.min(POPOVER_WIDTH, window.innerWidth - 24);

  createAnchorEffect(popover.open, () => {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    // Left-aligned with the line: placeBelow aligns right edges, so anchor it
    // where the popover's right edge would be.
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    setPlace(placeBelow({ right: rect.left + width(), bottom: rect.bottom }, width(), viewport));
  });

  const plan = () => taskPlanView(props.task.id).steps;
  const done = () => plan().filter((step) => step.status === 'completed').length;
  const goal = () => taskGoal(props.task);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        class="ctx-strip"
        aria-haspopup="dialog"
        aria-expanded={popover.open()}
        // Hint lives in the tooltip so the dense header stays quiet until there's content.
        title={
          plan().length === 0 && !goal()
            ? "The agent's plan shows here once it writes a to-do list"
            : undefined
        }
        onClick={(e) => {
          e.stopPropagation();
          popover.setShown(!popover.open());
        }}
      >
        <Show
          when={plan().length > 0}
          fallback={
            <>
              <span class="ctx-strip-label">Goal</span>
              <span class="ctx-strip-text">{goal()}</span>
            </>
          }
        >
          <span class="ctx-strip-label">Plan</span>
          <span class="ctx-strip-count">
            {done()}/{plan().length} ·
          </span>
          <span class="ctx-strip-text">{currentPlanStep(plan())}</span>
        </Show>
        <span class="ctx-strip-chevron" aria-hidden="true">
          {popover.open() ? '▴' : '▾'}
        </span>
      </button>
      <Show when={popover.open()}>
        <Portal>
          <div
            ref={panel}
            class="ctx-popover"
            role="dialog"
            aria-label="Task context"
            onClick={(e) => e.stopPropagation()}
            style={{
              top: `${place().top}px`,
              right: `${place().right}px`,
              width: `${width()}px`,
              'max-height': `${place().maxHeight}px`,
            }}
          >
            <TaskContext
              task={props.task}
              walkThroughDisabled={props.walkThroughDisabled}
              onWalkThrough={
                props.onWalkThrough
                  ? () => {
                      popover.setShown(false);
                      props.onWalkThrough?.();
                    }
                  : undefined
              }
            />
          </div>
        </Portal>
      </Show>
    </>
  );
}
