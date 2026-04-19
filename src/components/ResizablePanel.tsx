import { createSignal, createEffect, onMount, untrack, For, type JSX } from 'solid-js';
import { getPanelSize, setPanelSizes } from '../store/store';

export interface PanelChild {
  id: string;
  initialSize?: number;
  fixed?: boolean;
  /** Keep pixel size on window resize, but still allow manual drag resizing. */
  stable?: boolean;
  minSize?: number;
  maxSize?: number;
  /** Reactive getter — when the returned value changes, the panel resizes to it. */
  requestSize?: () => number;
  content: () => JSX.Element;
}

export interface ResizablePanelHandle {
  /** Adjust all non-fixed panels by deltaPx (positive = wider, negative = narrower). */
  resizeAll: (deltaPx: number) => void;
}

interface ResizablePanelProps {
  direction: 'horizontal' | 'vertical';
  children: PanelChild[];
  class?: string;
  style?: JSX.CSSProperties;
  /** When true, panels keep their initialSizes and the container grows to fit (useful with overflow scroll). */
  fitContent?: boolean;
  /** When set, panel sizes are persisted to the store under keys `{persistKey}:{childId}`. */
  persistKey?: string;
  /** Callback to receive a handle for programmatic resize operations. */
  onHandle?: (handle: ResizablePanelHandle) => void;
}

export function ResizablePanel(props: ResizablePanelProps) {
  let containerRef!: HTMLDivElement;
  // In fitContent mode: pixel sizes. In flex mode: flex-grow weights (pixel values that work as proportional weights).
  const [sizes, setSizes] = createSignal<number[]>([]);
  const [dragging, setDragging] = createSignal<number | null>(null);

  const isHorizontal = () => props.direction === 'horizontal';

  function initSizes() {
    if (!containerRef) return;
    const children = props.children;
    const handleSpace = Math.max(0, children.length - 1) * 6;

    // fitContent mode: use saved or initialSizes directly, no scaling
    if (props.fitContent) {
      setSizes(
        children.map((c) => {
          if (props.persistKey) {
            const saved = getPanelSize(`${props.persistKey}:${c.id}`);
            if (saved !== undefined) return saved;
          }
          return c.initialSize ?? 200;
        }),
      );
      return;
    }

    const totalSpace = isHorizontal() ? containerRef.clientWidth : containerRef.clientHeight;

    const fixedTotal = children.reduce(
      (sum, c) => sum + (c.fixed || c.stable ? (c.initialSize ?? 0) : 0),
      0,
    );
    const resizableSpace = totalSpace - fixedTotal - handleSpace;
    const resizableCount = children.filter((c) => !c.fixed && !c.stable).length;
    const defaultSize = resizableCount > 0 ? resizableSpace / resizableCount : 0;

    // First pass: assign saved sizes, initialSizes, or 0
    const initial = children.map((c) => {
      if (c.fixed || c.stable) return c.initialSize ?? 0;
      if (props.persistKey) {
        const saved = getPanelSize(`${props.persistKey}:${c.id}`);
        if (saved !== undefined) return saved;
      }
      return c.initialSize ?? 0;
    });
    // Compute how much space the resizable initialSizes consume
    const usedByResizable = children.reduce(
      (sum, c, i) => sum + (c.fixed || c.stable ? 0 : initial[i]),
      0,
    );
    // Count panels without a saved or initial size
    const unsetCount = children.filter((c) => {
      if (c.fixed || c.stable) return false;
      if (props.persistKey && getPanelSize(`${props.persistKey}:${c.id}`) !== undefined)
        return false;
      return !c.initialSize;
    }).length;
    // Distribute remaining space among resizable panels without a size
    const remaining = resizableSpace - usedByResizable;
    const extraEach = unsetCount > 0 ? remaining / unsetCount : 0;
    // If all have sizes but don't fill, scale them proportionally
    const scale = usedByResizable > 0 && unsetCount === 0 ? resizableSpace / usedByResizable : 1;

    setSizes(
      children.map((c, i) => {
        if (c.fixed || c.stable) return initial[i];
        if (initial[i] === 0) return extraEach > 0 ? extraEach : defaultSize;
        return initial[i] * scale;
      }),
    );
  }

  /** Compute actual rendered pixel sizes from flex-grow weights + container dimensions. */
  function computeRenderedSizes(): number[] {
    const current = sizes();
    const totalSpace = isHorizontal() ? containerRef.clientWidth : containerRef.clientHeight;
    const handleSpace = Math.max(0, props.children.length - 1) * 6;
    let fixedTotal = 0;
    let totalWeight = 0;
    for (let i = 0; i < props.children.length; i++) {
      if (props.children[i].fixed || props.children[i].stable) fixedTotal += current[i];
      else totalWeight += current[i];
    }
    const available = Math.max(0, totalSpace - fixedTotal - handleSpace);
    return current.map((s, i) => {
      if (props.children[i]?.fixed || props.children[i]?.stable) return s;
      return totalWeight > 0 ? (s / totalWeight) * available : 0;
    });
  }

  onMount(() => {
    initSizes();

    props.onHandle?.({
      resizeAll(deltaPx: number) {
        setSizes((prev) =>
          prev.map((s, i) => {
            const child = props.children[i];
            if (child.fixed) return s;
            const min = child.minSize ?? 30;
            const max = child.maxSize ?? Infinity;
            return Math.min(max, Math.max(min, s + deltaPx));
          }),
        );
        if (props.persistKey) {
          const current = sizes();
          const entries: Record<string, number> = {};
          for (let i = 0; i < props.children.length; i++) {
            const child = props.children[i];
            if (!child.fixed) {
              entries[`${props.persistKey}:${child.id}`] = current[i];
            }
          }
          setPanelSizes(entries);
        }
      },
    });

    // CSS flex handles proportional scaling for non-fitContent panels — no ResizeObserver needed
  });

  // Re-init when children change (untrack initSizes to avoid store reads creating dependencies)
  createEffect(() => {
    void props.children.length;
    untrack(() => initSizes());
  });

  // Watch requestSize getters and adjust sizes dynamically
  createEffect(() => {
    const current = untrack(() => sizes());
    if (current.length === 0) return;

    // Work in rendered pixel space so requestSize (in pixels) and diff math use the same units
    const rendered = props.fitContent ? current : untrack(() => computeRenderedSizes());
    const next = [...rendered];
    let changed = false;

    for (let i = 0; i < props.children.length; i++) {
      const child = props.children[i];
      if (!child.requestSize) continue;
      const requested = child.requestSize();
      if (Math.abs(next[i] - requested) < 1) continue;

      const diff = requested - next[i];
      // Find nearest resizable neighbor to absorb the difference.
      // Skip fixed and stable panels — only truly resizable panels give/take space.
      let absorbed = false;
      for (let j = i + 1; j < props.children.length; j++) {
        if (!props.children[j].fixed && !props.children[j].stable) {
          next[j] = Math.max(props.children[j].minSize ?? 30, next[j] - diff);
          absorbed = true;
          break;
        }
      }
      if (!absorbed) {
        for (let j = i - 1; j >= 0; j--) {
          if (!props.children[j].fixed && !props.children[j].stable) {
            next[j] = Math.max(props.children[j].minSize ?? 30, next[j] - diff);
            break;
          }
        }
      }
      next[i] = requested;
      changed = true;
    }

    if (changed) setSizes(next);
  });

  function findResizable(start: number, direction: -1 | 1): number {
    for (let i = start; i >= 0 && i < props.children.length; i += direction) {
      if (!props.children[i].fixed && !props.children[i].stable) return i;
    }
    return -1;
  }

  function handleMouseDown(handleIndex: number, e: MouseEvent) {
    e.preventDefault();
    setDragging(handleIndex);

    const startPos = isHorizontal() ? e.clientX : e.clientY;
    // For flex-based panels, snapshot actual rendered pixel sizes so drag math works correctly
    const startSizes = props.fitContent ? [...sizes()] : computeRenderedSizes();

    // Resolve which panels actually resize: skip over fixed panels
    const leftChild = props.children[handleIndex];
    const rightChild = props.children[handleIndex + 1];
    const resizeLeftIdx = leftChild?.fixed ? findResizable(handleIndex, -1) : handleIndex;
    const resizeRightIdx = rightChild?.fixed ? findResizable(handleIndex + 1, 1) : handleIndex + 1;

    // Both sides are fixed (or no resizable found) — can't drag
    // In fitContent mode, only the left panel is resized, so we only need a valid left index
    if (resizeLeftIdx < 0) return;
    if (resizeRightIdx < 0 && !props.fitContent) return;

    const leftPanel = props.children[resizeLeftIdx];
    const rightPanel = props.children[resizeRightIdx];

    function onMove(ev: MouseEvent) {
      const delta = (isHorizontal() ? ev.clientX : ev.clientY) - startPos;

      if (props.fitContent) {
        // In fitContent mode, only resize the left panel — container scrolls
        const leftMin = leftPanel?.minSize ?? 30;
        const leftMax = leftPanel?.maxSize ?? Infinity;
        const newLeft = Math.max(leftMin, Math.min(leftMax, startSizes[resizeLeftIdx] + delta));
        setSizes((prev) => {
          const next = [...prev];
          next[resizeLeftIdx] = newLeft;
          return next;
        });
        return;
      }

      let newLeft = startSizes[resizeLeftIdx] + delta;
      let newRight = startSizes[resizeRightIdx] - delta;

      const leftMin = leftPanel?.minSize ?? 30;
      const leftMax = leftPanel?.maxSize ?? Infinity;
      const rightMin = rightPanel?.minSize ?? 30;
      const rightMax = rightPanel?.maxSize ?? Infinity;

      if (newLeft < leftMin) {
        newRight += newLeft - leftMin;
        newLeft = leftMin;
      }
      if (newRight < rightMin) {
        newLeft += newRight - rightMin;
        newRight = rightMin;
      }
      newLeft = Math.min(newLeft, leftMax);
      newRight = Math.min(newRight, rightMax);

      // Use startSizes (rendered pixels) as base so all entries share the same unit space
      setSizes(() => {
        const next = [...startSizes];
        next[resizeLeftIdx] = newLeft;
        next[resizeRightIdx] = newRight;
        return next;
      });
    }

    function onUp() {
      setDragging(null);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);

      if (props.persistKey) {
        const current = sizes();
        const entries: Record<string, number> = {};
        for (let i = 0; i < props.children.length; i++) {
          const child = props.children[i];
          if (!child.fixed) {
            entries[`${props.persistKey}:${child.id}`] = current[i];
          }
        }
        setPanelSizes(entries);
      }
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  return (
    <div
      ref={containerRef}
      class={props.class}
      style={{
        display: 'flex',
        'flex-direction': isHorizontal() ? 'row' : 'column',
        width: props.fitContent ? 'fit-content' : '100%',
        'min-width': props.fitContent ? '100%' : undefined,
        height: '100%',
        overflow: 'hidden',
        ...props.style,
      }}
    >
      <For each={props.children}>
        {(child, i) => {
          const size = () => sizes()[i()] ?? 0;
          const showHandle = () => {
            const idx = i();
            if (idx >= props.children.length - 1) return false;

            const leftFixed = child.fixed;
            const rightFixed = props.children[idx + 1]?.fixed;

            if (leftFixed && rightFixed) return false;

            // Hide handle if no resizable panel exists on either side
            if (leftFixed && findResizable(idx, -1) < 0) return false;
            if (!props.fitContent && rightFixed && findResizable(idx + 1, 1) < 0) return false;

            return true;
          };

          return (
            <>
              <div
                style={(() => {
                  const dim = isHorizontal() ? 'width' : 'height';
                  const minDim = isHorizontal() ? 'min-width' : 'min-height';
                  const maxDim = isHorizontal() ? 'max-width' : 'max-height';
                  const s = size();
                  const min = child.minSize ?? 0;

                  // fitContent mode: pixel-based sizing (unchanged)
                  if (props.fitContent) {
                    return {
                      [dim]: `${s}px`,
                      [minDim]: `${min}px`,
                      'flex-shrink': '0',
                      overflow: 'hidden',
                    };
                  }

                  // Fixed panels: exact pixel size, no grow/shrink
                  if (child.fixed) {
                    return {
                      flex: `0 0 ${s}px`,
                      [minDim]: `${min}px`,
                      overflow: 'hidden',
                    };
                  }

                  // Stable panels: exact pixel size, no grow/shrink
                  if (child.stable) {
                    return {
                      flex: `0 0 ${s}px`,
                      [minDim]: `${min}px`,
                      [maxDim]: `${s}px`,
                      overflow: 'hidden',
                    };
                  }

                  // Resizable panels: flex-grow proportional sizing
                  return {
                    flex: `${s} 1 0px`,
                    [minDim]: `${min}px`,
                    [maxDim]: child.maxSize ? `${child.maxSize}px` : undefined,
                    overflow: 'hidden',
                  };
                })()}
              >
                {child.content()}
              </div>
              {(() => {
                const idx = i();
                /* eslint-disable solid/components-return-once */
                if (idx >= props.children.length - 1) return null;

                if (showHandle()) {
                  return (
                    <div
                      class={`resize-handle resize-handle-${isHorizontal() ? 'h' : 'v'} ${dragging() === idx ? 'dragging' : ''}`}
                      onMouseDown={(e) => handleMouseDown(idx, e)}
                    />
                  );
                }

                // No spacer between two adjacent fixed panels
                if (child.fixed && props.children[idx + 1]?.fixed) return null;

                // Non-interactive spacer (preserves gap without hover effect)
                return (
                  <div
                    style={{ [isHorizontal() ? 'width' : 'height']: '12px', 'flex-shrink': '0' }}
                  />
                );
                /* eslint-enable solid/components-return-once */
              })()}
            </>
          );
        }}
      </For>
    </div>
  );
}
