import { createSignal, createEffect, onMount, onCleanup, untrack, For, type JSX } from "solid-js";

export interface PanelChild {
  id: string;
  initialSize?: number;
  fixed?: boolean;
  minSize?: number;
  maxSize?: number;
  /** Reactive getter — when the returned value changes, the panel resizes to it. */
  requestSize?: () => number;
  content: () => JSX.Element;
}

interface ResizablePanelProps {
  direction: "horizontal" | "vertical";
  children: PanelChild[];
  class?: string;
  style?: JSX.CSSProperties;
  /** When true, panels keep their initialSizes and the container grows to fit (useful with overflow scroll). */
  fitContent?: boolean;
}

export function ResizablePanel(props: ResizablePanelProps) {
  let containerRef!: HTMLDivElement;
  const [sizes, setSizes] = createSignal<number[]>([]);
  const [dragging, setDragging] = createSignal<number | null>(null);

  const isHorizontal = () => props.direction === "horizontal";

  function initSizes() {
    if (!containerRef) return;
    const children = props.children;
    const handleSpace = Math.max(0, children.length - 1) * 6;

    // fitContent mode: use initialSizes directly, no scaling
    if (props.fitContent) {
      setSizes(children.map((c) => c.initialSize ?? 200));
      return;
    }

    const totalSpace = isHorizontal()
      ? containerRef.clientWidth
      : containerRef.clientHeight;

    const fixedTotal = children.reduce(
      (sum, c) => sum + (c.fixed ? (c.initialSize ?? 0) : 0),
      0
    );
    const resizableSpace = totalSpace - fixedTotal - handleSpace;
    const resizableCount = children.filter((c) => !c.fixed).length;
    const defaultSize = resizableCount > 0 ? resizableSpace / resizableCount : 0;

    // First pass: assign initialSizes or 0
    const initial = children.map((c) => {
      if (c.fixed) return c.initialSize ?? 0;
      return c.initialSize ?? 0;
    });
    // Compute how much space the resizable initialSizes consume
    const usedByResizable = children.reduce(
      (sum, c, i) => sum + (c.fixed ? 0 : initial[i]),
      0
    );
    // Distribute remaining space among resizable panels without an initialSize
    const unsetCount = children.filter((c) => !c.fixed && !c.initialSize).length;
    const remaining = resizableSpace - usedByResizable;
    const extraEach = unsetCount > 0 ? remaining / unsetCount : 0;
    // If all have initialSizes but don't fill, scale them proportionally
    const scale = usedByResizable > 0 && unsetCount === 0
      ? resizableSpace / usedByResizable
      : 1;

    setSizes(
      children.map((c, i) => {
        if (c.fixed) return initial[i];
        if (!c.initialSize) return extraEach > 0 ? extraEach : defaultSize;
        return initial[i] * scale;
      })
    );
  }

  onMount(() => {
    initSizes();

    // fitContent mode doesn't need resize observer scaling
    if (props.fitContent) return;

    const ro = new ResizeObserver(() => {
      const current = sizes();
      if (current.length === 0) {
        initSizes();
        return;
      }

      const totalSpace = isHorizontal()
        ? containerRef.clientWidth
        : containerRef.clientHeight;
      const handleSpace = Math.max(0, props.children.length - 1) * 6;
      const fixedTotal = props.children.reduce(
        (sum, c, i) => sum + (c.fixed ? current[i] : 0),
        0
      );
      const oldResizable = current.reduce(
        (sum, s, i) => sum + (props.children[i]?.fixed ? 0 : s),
        0
      );
      const newResizable = totalSpace - fixedTotal - handleSpace;

      if (oldResizable <= 0 || newResizable <= 0) return;

      const ratio = newResizable / oldResizable;
      setSizes(
        current.map((s, i) => (props.children[i]?.fixed ? s : s * ratio))
      );
    });
    ro.observe(containerRef);
    onCleanup(() => ro.disconnect());
  });

  // Re-init when children change
  createEffect(() => {
    void props.children.length;
    initSizes();
  });

  // Watch requestSize getters and adjust sizes dynamically
  createEffect(() => {
    const current = untrack(() => sizes());
    if (current.length === 0) return;

    const next = [...current];
    let changed = false;

    for (let i = 0; i < props.children.length; i++) {
      const child = props.children[i];
      if (!child.requestSize) continue;
      const requested = child.requestSize();
      if (Math.abs(next[i] - requested) < 1) continue;

      const diff = requested - next[i];
      // Find nearest resizable neighbor to absorb the difference
      let absorbed = false;
      for (let j = i + 1; j < props.children.length; j++) {
        if (!props.children[j].fixed) {
          next[j] = Math.max(props.children[j].minSize ?? 30, next[j] - diff);
          absorbed = true;
          break;
        }
      }
      if (!absorbed) {
        for (let j = i - 1; j >= 0; j--) {
          if (!props.children[j].fixed) {
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
      if (!props.children[i].fixed) return i;
    }
    return -1;
  }

  function handleMouseDown(handleIndex: number, e: MouseEvent) {
    e.preventDefault();
    setDragging(handleIndex);

    const startPos = isHorizontal() ? e.clientX : e.clientY;
    const startSizes = [...sizes()];

    // Resolve which panels actually resize: skip over fixed panels
    const leftChild = props.children[handleIndex];
    const rightChild = props.children[handleIndex + 1];
    const resizeLeftIdx = leftChild?.fixed
      ? findResizable(handleIndex, -1)
      : handleIndex;
    const resizeRightIdx = rightChild?.fixed
      ? findResizable(handleIndex + 1, 1)
      : handleIndex + 1;

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

      setSizes((prev) => {
        const next = [...prev];
        next[resizeLeftIdx] = newLeft;
        next[resizeRightIdx] = newRight;
        return next;
      });
    }

    function onUp() {
      setDragging(null);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div
      ref={containerRef}
      class={props.class}
      style={{
        display: "flex",
        "flex-direction": isHorizontal() ? "row" : "column",
        width: props.fitContent ? "fit-content" : "100%",
        "min-width": props.fitContent ? "100%" : undefined,
        height: "100%",
        overflow: "hidden",
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
                style={{
                  [isHorizontal() ? "width" : "height"]: `${size()}px`,
                  [isHorizontal() ? "min-width" : "min-height"]: `${child.minSize ?? 0}px`,
                  "flex-shrink": "0",
                  overflow: "hidden",
                }}
              >
                {child.content()}
              </div>
              {showHandle() && (
                <div
                  class={`resize-handle resize-handle-${isHorizontal() ? "h" : "v"} ${dragging() === i() ? "dragging" : ""}`}
                  onMouseDown={(e) => handleMouseDown(i(), e)}
                />
              )}
            </>
          );
        }}
      </For>
    </div>
  );
}
