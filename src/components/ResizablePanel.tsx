import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js';
import { getPanelUserSize, setPanelUserSize, deletePanelUserSize } from '../store/store';

export interface PanelChild {
  id: string;
  content: () => JSX.Element;
  minSize?: number;
  /** Starting flex-basis (px) for non-absorbers without a user-pinned size.
   *  Without this, non-absorbers fall back to `auto` (content-sized), which
   *  in horizontal splits lets wide intrinsic content push the column far
   *  past its min. Use whenever content-driven sizing would surprise. */
  defaultSize?: number;
  /** Maximum content-driven size for non-absorbers without a user-pinned size.
   *  A number is treated as px; a string is used verbatim as a CSS length
   *  (e.g. `min(400px, 33vh)`). User drag pins intentionally ignore this so a
   *  panel can still be made larger when desired. */
  maxAutoSize?: number | string;
  /** Reactive. When true, the child stays content-sized: no user-pin lookup,
   *  no drag-time override, and drags adjacent to it route the freed space
   *  through the layout absorber. Use for panels whose intrinsic height is
   *  smaller than their pinned size would be (e.g., a toolbar that collapses
   *  when its body is empty), so a stale pin can't leave a visible gap. */
  noPin?: () => boolean;
  /** Relative flex-grow weight among absorbers. Defaults to 1 (equal share).
   *  Ignored on non-absorbers. Use a smaller value to give an absorber less
   *  space than its siblings, e.g. 0.5 so the AI terminal gets ~2/3. */
  absorberWeight?: number;
  /** Accessible name for the keyboard-resizable separator that controls this
   *  child. A handle takes the label of its fixed (non-absorber) neighbour, the
   *  side the arrow keys resize, so label the pinnable pane, e.g. 'Resize
   *  agent pane'. Ignored on absorbers and on drag-only handles. */
  resizeLabel?: string;
}

interface ResizablePanelProps {
  direction: 'horizontal' | 'vertical';
  children: PanelChild[];
  /** Persist drag sizes under `${persistKey}:${childId}` (pixels for fixed
   *  children, relative weights for multiple absorbers). */
  persistKey?: string;
  /** IDs of the children that flex-absorb remaining space. Defaults to the
   *  last child. Multiple entries split remaining space equally via
   *  `flex: 1 1 0` on each. A sole absorber stays flexible; multiple absorbers
   *  save their proportions together after a drag. */
  absorberIds?: string[];
  class?: string;
  style?: JSX.CSSProperties;
}

const KEYBOARD_STEP = 24;

const roundOrUndefined = (n: number | undefined) => (n === undefined ? undefined : Math.round(n));

export function ResizablePanel(props: ResizablePanelProps) {
  const [draggingIdx, setDraggingIdx] = createSignal<number | null>(null);
  // Bumped when sizes may have changed so aria values re-read the layout.
  const [measureTick, setMeasureTick] = createSignal(0);
  const refreshMeasures = () => setMeasureTick((n) => n + 1);
  // Nothing is measurable until the tree is attached; re-read then and whenever
  // the container resizes (window resize or an ancestor layout change).
  let rootEl: HTMLDivElement | undefined;
  onMount(() => {
    refreshMeasures();
    if (typeof ResizeObserver === 'undefined' || !rootEl) return;
    const observer = new ResizeObserver(refreshMeasures);
    observer.observe(rootEl);
    onCleanup(() => observer.disconnect());
  });
  const [dragOverride, setDragOverride] = createSignal<Record<string, number>>({});
  /** Stable per-ID refs so drag measurement survives dynamic children changes. */
  const wrapperRefs = new Map<string, HTMLDivElement>();
  let cancelDrag: (() => void) | undefined;
  onCleanup(() => cancelDrag?.());
  createEffect(
    on(
      () => [props.direction, props.persistKey, ...props.children.map((child) => child.id)],
      () => cancelDrag?.(),
    ),
  );

  const isHorizontal = () => props.direction === 'horizontal';

  const absorberSet = createMemo((): Set<string> => {
    const ids = props.absorberIds;
    if (ids && ids.length > 0) return new Set(ids);
    const last = props.children[props.children.length - 1];
    return last ? new Set([last.id]) : new Set();
  });
  const isAbsorber = (childId: string) => absorberSet().has(childId);

  const keyFor = (childId: string): string | null =>
    props.persistKey ? `${props.persistKey}:${childId}` : null;

  /** Sole absorbers and noPin children must never carry a persisted pin —
   *  the drag-release path refuses to write one, but legacy data, renamed
   *  absorbers, or a child that just turned noPin (e.g., last terminal closed
   *  with a pin still in the store) can leave stale entries behind. Detect
   *  and delete so the store self-heals instead of silently diverging from
   *  what the user sees.
   *
   *  Multi-absorber panels store pin values as flex-grow ratios (all absorbers
   *  pinned after a drag). If only ONE absorber carries a pin while the others
   *  are unpinned, it's a stale pixel value from before the child was promoted
   *  to absorber status — treat it as stale to prevent a 300:1 ratio that
   *  would starve every other absorber. */
  createEffect(() => {
    const absorbers = absorberSet();
    const stale: string[] = [];

    // For multi-absorber panels, count how many absorbers are currently pinned.
    // If exactly one is pinned it's asymmetric (stale pixel value), so clear it.
    let pinnedAbsorberCount = 0;
    if (absorbers.size > 1) {
      for (const child of props.children) {
        if (!absorbers.has(child.id)) continue;
        const key = keyFor(child.id);
        if (key && getPanelUserSize(key) !== undefined) pinnedAbsorberCount++;
      }
    }
    const asymmetricAbsorberPin = absorbers.size > 1 && pinnedAbsorberCount === 1;

    for (const child of props.children) {
      const isSoleAbsorber = absorbers.size === 1 && absorbers.has(child.id);
      const noPin = child.noPin?.() === true;
      const isStaleAsymmetric = asymmetricAbsorberPin && absorbers.has(child.id);
      if (!isSoleAbsorber && !noPin && !isStaleAsymmetric) continue;
      const key = keyFor(child.id);
      if (key && getPanelUserSize(key) !== undefined) stale.push(key);
    }
    if (stale.length > 0) deletePanelUserSize(stale);
  });

  function childStyle(child: PanelChild): JSX.CSSProperties {
    const noPin = child.noPin?.() === true;
    // noPin children can't be sized by drag override or persisted pin — they
    // stay content-sized so an empty inner state can't leave a visible gap.
    const key = keyFor(child.id);
    const raw = noPin
      ? undefined
      : (dragOverride()[child.id] ?? (key ? getPanelUserSize(key) : undefined));
    const pinned = raw !== undefined && Number.isFinite(raw) && raw > 0 ? raw : undefined;
    const dim = isHorizontal() ? 'width' : 'height';
    const minDim = isHorizontal() ? 'min-width' : 'min-height';
    const maxDim = isHorizontal() ? 'max-width' : 'max-height';
    const min = child.minSize ?? 0;

    if (pinned !== undefined) {
      // Drag override uses pixel-precise flex for live visual feedback.
      // Persisted pins on absorbers use flex-grow ratio so they scale when the
      // container resizes (e.g. notes/changed-files in a horizontal split that
      // should stay proportional with the window).
      if (isAbsorber(child.id) && dragOverride()[child.id] === undefined) {
        return {
          flex: `${pinned} 1 0`,
          [minDim]: `${min}px`,
          overflow: 'hidden',
        };
      }
      return {
        flex: `0 ${isHorizontal() ? 1 : 0} ${pinned}px`,
        [dim]: `${pinned}px`,
        [minDim]: `${min}px`,
        overflow: 'hidden',
      };
    }
    if (isAbsorber(child.id)) {
      const fg = child.absorberWeight ?? 1;
      return {
        flex: `${fg} 1 0`,
        [minDim]: `${min}px`,
        overflow: 'hidden',
      };
    }
    if (child.defaultSize !== undefined) {
      return {
        flex: `0 ${isHorizontal() ? 1 : 0} ${child.defaultSize}px`,
        [dim]: `${child.defaultSize}px`,
        [minDim]: `${min}px`,
        overflow: 'hidden',
      };
    }
    return {
      flex: '0 0 auto',
      [minDim]: `${min}px`,
      ...(child.maxAutoSize !== undefined
        ? {
            [maxDim]:
              typeof child.maxAutoSize === 'number' ? `${child.maxAutoSize}px` : child.maxAutoSize,
          }
        : {}),
      overflow: 'hidden',
    };
  }

  function measureWrapper(childId: string): number {
    const el = wrapperRefs.get(childId);
    if (!el) return 0;
    return isHorizontal() ? el.getBoundingClientRect().width : el.getBoundingClientRect().height;
  }

  function beginDrag(handleIdx: number, e: MouseEvent) {
    if (e.button !== 0) return;
    cancelDrag?.();
    e.preventDefault();
    const leftChild = props.children[handleIdx];
    const rightChild = props.children[handleIdx + 1];
    if (!leftChild || !rightChild) return;

    const leftIsAbs = isAbsorber(leftChild.id);
    const rightIsAbs = isAbsorber(rightChild.id);
    const leftNoPin = leftChild.noPin?.() === true;
    const rightNoPin = rightChild.noPin?.() === true;

    setDraggingIdx(handleIdx);
    const startPos = isHorizontal() ? e.clientX : e.clientY;
    const startLeft = measureWrapper(leftChild.id);
    const startRight = measureWrapper(rightChild.id);
    const leftMin = leftChild.minSize ?? 0;
    const rightMin = rightChild.minSize ?? 0;
    let latestLeft = startLeft;
    let latestRight = startRight;
    const absorberSizes: Record<string, number> = {};
    for (const child of props.children) {
      if (isAbsorber(child.id) && !child.noPin?.()) {
        absorberSizes[child.id] = measureWrapper(child.id);
      }
    }

    // When one side is noPin its size stays fixed at content. If the layout
    // absorber is a *separate* child elsewhere in the tree, the freed space
    // flows through it — measure up front so the drag can clamp by its
    // minSize. If the absorber is the noPin side's neighbor (sole-absorber +
    // noPin in the same child, e.g. split-mode shell-section), no rerouted
    // absorber is needed; the drag still works because the neighbor's flex:1 1 0
    // grows/shrinks naturally and the other side's own minSize covers clamps.
    let absorberStart = 0;
    let absorberMin = 0;
    let reroutedAbsorberId: string | undefined;
    if (leftNoPin || rightNoPin) {
      for (const c of props.children) {
        if (c.id === leftChild.id || c.id === rightChild.id) continue;
        if (isAbsorber(c.id)) {
          absorberStart = measureWrapper(c.id);
          absorberMin = c.minSize ?? 0;
          reroutedAbsorberId = c.id;
          break;
        }
      }
    }
    const soleAbs = absorberSet().size === 1;

    const onMove = (ev: MouseEvent) => {
      let delta = (isHorizontal() ? ev.clientX : ev.clientY) - startPos;
      if (!leftNoPin && startLeft + delta < leftMin) delta = leftMin - startLeft;
      if (!rightNoPin && startRight - delta < rightMin) delta = startRight - rightMin;
      // Absorber clamps when noPin reroutes the delta through it. With
      // rightNoPin the absorber gives up `delta`; with leftNoPin it absorbs
      // `-delta`. Either way the absorber must stay above its minSize.
      if (rightNoPin && reroutedAbsorberId && absorberStart - delta < absorberMin) {
        delta = absorberStart - absorberMin;
      }
      if (leftNoPin && reroutedAbsorberId && absorberStart + delta < absorberMin) {
        delta = absorberMin - absorberStart;
      }
      latestLeft = startLeft + delta;
      latestRight = startRight - delta;
      // Skip the override on noPin children so they stay content-sized; also
      // skip on a sole absorber adjacent to a noPin sibling, since pinning the
      // absorber temporarily would steal the space the noPin child can't take.
      // Freeze every absorber: leaving only a fractional grow weight (e.g.
      // notes at 0.25) in flex layout would consume only part of the free space.
      const override: Record<string, number> = soleAbs ? {} : { ...absorberSizes };
      if (!soleAbs && reroutedAbsorberId) {
        override[reroutedAbsorberId] = absorberStart + (leftNoPin ? delta : -delta);
      }
      if (!leftNoPin && !(leftIsAbs && rightNoPin && soleAbs)) {
        override[leftChild.id] = latestLeft;
      }
      if (!rightNoPin && !(rightIsAbs && leftNoPin && soleAbs)) {
        override[rightChild.id] = latestRight;
      }
      setDragOverride(override);
    };
    const cleanup = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', cancel);
      cancelDrag = undefined;
      setDraggingIdx(null);
      queueMicrotask(refreshMeasures);
    };
    const cancel = () => {
      cleanup();
      setDragOverride({});
    };
    const onUp = () => {
      cleanup();
      if (latestLeft === startLeft && latestRight === startRight) {
        setDragOverride({});
        return;
      }
      const leftKey = leftNoPin || leftIsAbs ? null : keyFor(leftChild.id);
      const rightKey = rightNoPin || rightIsAbs ? null : keyFor(rightChild.id);
      // Capture all absorber sizes before changing any styles. Saving only
      // adjacent absorbers loses the split or mixes old weights with pixels.
      const absorberPins = soleAbs
        ? []
        : props.children
            .filter((child) => isAbsorber(child.id) && !child.noPin?.())
            .map((child) => ({ key: keyFor(child.id), size: measureWrapper(child.id) }));
      batch(() => {
        if (leftKey) setPanelUserSize(leftKey, latestLeft);
        if (rightKey) setPanelUserSize(rightKey, latestRight);
        for (const { key, size } of absorberPins) {
          if (key && size > 0) setPanelUserSize(key, size);
        }
        // Clear the drag override in the same batch so there's no frame where
        // both the override and the fresh userSize are absent.
        setDragOverride({});
      });
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', cancel);
    cancelDrag = cancel;
  }

  function unpin(handleIdx: number) {
    const left = props.children[handleIdx];
    const right = props.children[handleIdx + 1];
    if (!left || !right || !props.persistKey) return;
    deletePanelUserSize([`${props.persistKey}:${left.id}`, `${props.persistKey}:${right.id}`]);
  }

  /** The fixed-size side a keyboard can resize: one pinnable child beside the sole
   *  absorber. Other layouts stay drag-only rather than guess how to share space. */
  function keyboardTarget(handleIdx: number) {
    const left = props.children[handleIdx];
    const right = props.children[handleIdx + 1];
    if (!left || !right || !props.persistKey || absorberSet().size !== 1) return null;
    if (left.noPin?.() === true || right.noPin?.() === true) return null;
    if (isAbsorber(left.id) === isAbsorber(right.id)) return null;
    const fixedIsLeft = !isAbsorber(left.id);
    return fixedIsLeft
      ? { fixed: left, absorber: right, sign: 1 }
      : { fixed: right, absorber: left, sign: -1 };
  }

  /** Measured size and limits of the keyboard-controlled pane, or null when
   *  nothing meaningful can be measured (the handle then isn't focusable).
   *  `max` never drops below `current`: an absorber already under its minimum
   *  must not make a grow key shrink the pane. */
  function keyboardRange(handleIdx: number) {
    measureTick();
    const target = keyboardTarget(handleIdx);
    if (!target) return null;
    const current = measureWrapper(target.fixed.id);
    if (!(current > 0)) return null;
    const room = measureWrapper(target.absorber.id) - (target.absorber.minSize ?? 0);
    return { target, current, min: target.fixed.minSize ?? 0, max: current + Math.max(0, room) };
  }

  function keyboardSize(key: string, range: { current: number; min: number; max: number }) {
    if (key === 'Home') return range.min;
    if (key === 'End') return range.max;
    return undefined;
  }

  function nudge(handleIdx: number, e: KeyboardEvent) {
    const range = keyboardRange(handleIdx);
    if (!range) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      unpin(handleIdx);
      queueMicrotask(refreshMeasures);
      return;
    }
    const toward = isHorizontal() ? 'ArrowRight' : 'ArrowDown';
    const away = isHorizontal() ? 'ArrowLeft' : 'ArrowUp';
    const { fixed, sign } = range.target;
    let wanted = keyboardSize(e.key, range);
    if (e.key === toward || e.key === away) {
      wanted = range.current + (e.key === toward ? sign : -sign) * KEYBOARD_STEP;
    }
    if (wanted === undefined) return;
    e.preventDefault();
    const size = Math.min(range.max, Math.max(range.min, wanted));
    const key = keyFor(fixed.id);
    if (key && size > 0) setPanelUserSize(key, Math.round(size));
    queueMicrotask(refreshMeasures);
  }

  /** Hide handles where the drag can't produce a visible change: when one
   *  side is noPin and the SOLE absorber is a separate child on the other
   *  side, neither side can grow or shrink, so a visible handle would be a
   *  no-op trap for the user. If the noPin side is itself the absorber, the
   *  other side's override still drives a visible drag (the absorber shrinks
   *  via flex:1 1 0), so the handle stays. */
  function isHandleInert(handleIdx: number): boolean {
    const left = props.children[handleIdx];
    const right = props.children[handleIdx + 1];
    if (!left || !right) return false;
    const leftNoPin = left.noPin?.() === true;
    const rightNoPin = right.noPin?.() === true;
    if (leftNoPin && rightNoPin) return true;
    const sole = absorberSet().size === 1;
    if (sole && leftNoPin && !isAbsorber(left.id) && isAbsorber(right.id)) return true;
    if (sole && rightNoPin && !isAbsorber(right.id) && isAbsorber(left.id)) return true;
    return false;
  }

  return (
    <div
      ref={rootEl}
      class={props.class}
      style={{
        display: 'flex',
        'flex-direction': isHorizontal() ? 'row' : 'column',
        width: '100%',
        height: '100%',
        // Keep both panes reachable when even their minimum widths cannot fit.
        overflow: isHorizontal() ? 'auto' : 'hidden',
        ...props.style,
      }}
    >
      <For each={props.children}>
        {(child, i) => {
          // Measuring reads the layout; share one read among this handle's aria attributes.
          const range = createMemo(() => keyboardRange(i()));
          return (
            <>
              <div
                class="rp-cell"
                ref={(el) => {
                  wrapperRefs.set(child.id, el);
                  onCleanup(() => wrapperRefs.delete(child.id));
                }}
                style={childStyle(child)}
              >
                {child.content()}
              </div>
              {i() < props.children.length - 1 && !isHandleInert(i()) && (
                <div
                  class={`resize-handle resize-handle-${isHorizontal() ? 'h' : 'v'} ${draggingIdx() === i() ? 'dragging' : ''}`}
                  role="separator"
                  aria-orientation={isHorizontal() ? 'vertical' : 'horizontal'}
                  aria-label={range()?.target.fixed.resizeLabel}
                  aria-valuenow={roundOrUndefined(range()?.current)}
                  aria-valuemin={roundOrUndefined(range()?.min)}
                  aria-valuemax={roundOrUndefined(range()?.max)}
                  tabIndex={range() ? 0 : undefined}
                  onFocus={refreshMeasures}
                  onKeyDown={(e) => nudge(i(), e)}
                  onMouseDown={(e) => beginDrag(i(), e)}
                  onDblClick={() => unpin(i())}
                />
              )}
            </>
          );
        }}
      </For>
    </div>
  );
}
