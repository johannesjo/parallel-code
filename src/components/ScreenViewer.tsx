import { Show, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import type { ScreenImage, ScreenShot } from '../../electron/shared/task-screens';
import {
  FIT_VIEW,
  clampView,
  panBy,
  zoomAt,
  type ZoomBounds,
  type ZoomView,
} from '../lib/zoom-pan';
import { Dialog } from './Dialog';
import { IconButton } from './IconButton';
import { ChevronLeftIcon, ChevronRightIcon, ExternalLinkIcon } from './icons';

/** One image of a capture, as the viewer steps through them. */
export interface ViewerImage {
  /** Index of the screen it belongs to; before and after share it. */
  shot: number;
  label: string;
  side: 'Before' | 'After';
  image: ScreenImage;
}

/** Every image of a capture in viewing order: each screen's before, then its after. */
export function viewerImages(shots: ScreenShot[]): ViewerImage[] {
  return shots.flatMap((shot, index) => [
    ...(shot.before
      ? [{ shot: index, label: shot.label, side: 'Before' as const, image: shot.before }]
      : []),
    { shot: index, label: shot.label, side: 'After' as const, image: shot.after },
  ]);
}

const WHEEL_STEP = 1.1;
const KEY_STEP = 1.25;

/** Runs a handler for plain key presses while the viewer is open; modified keys stay app shortcuts. */
function createViewerKeys(open: () => boolean, keys: Record<string, () => void>) {
  createEffect(() => {
    if (!open()) return;
    const handler = (e: KeyboardEvent) => {
      const run = keys[e.key];
      if (!run || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      run();
    };
    document.addEventListener('keydown', handler);
    onCleanup(() => document.removeEventListener('keydown', handler));
  });
}

/** The fitted image and stage sizes; undefined before layout, when clamping has nothing to go by. */
function boundsOf(stage: HTMLDivElement | undefined): ZoomBounds | undefined {
  const image = stage?.querySelector('img');
  if (!stage || !image?.offsetWidth || !stage.clientWidth) return undefined;
  return {
    image: { width: image.offsetWidth, height: image.offsetHeight },
    stage: { width: stage.clientWidth, height: stage.clientHeight },
  };
}

/** Wheel zoom at the cursor, drag to pan and double-click to toggle, on one stage element. */
function createZoomPan() {
  const [view, setView] = createSignal<ZoomView>(FIT_VIEW);
  let stage: HTMLDivElement | undefined;
  let drag: { x: number; y: number } | undefined;
  // Every change is clamped, so the image never leaves the stage.
  const update = (change: (v: ZoomView) => ZoomView) =>
    setView((v) => {
      const bounds = boundsOf(stage);
      return bounds ? clampView(change(v), bounds) : change(v);
    });
  const pointFrom = (e: MouseEvent) => {
    const rect = stage?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: e.clientX - rect.left - rect.width / 2, y: e.clientY - rect.top - rect.height / 2 };
  };
  const handlers = {
    ref: (el: HTMLDivElement) => (stage = el),
    onWheel: (e: WheelEvent) => {
      e.preventDefault();
      update((v) => zoomAt(v, e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP, pointFrom(e)));
    },
    onPointerDown: (e: PointerEvent) => {
      if (view().scale === 1) return;
      drag = { x: e.clientX, y: e.clientY };
      stage?.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: PointerEvent) => {
      if (!drag) return;
      const from = drag;
      update((v) => panBy(v, e.clientX - from.x, e.clientY - from.y));
      drag = { x: e.clientX, y: e.clientY };
    },
    onPointerUp: () => (drag = undefined),
    onDblClick: (e: MouseEvent) =>
      update((v) => (v.scale === 1 ? zoomAt(v, 2, pointFrom(e)) : FIT_VIEW)),
  };
  const zoomBy = (factor: number) => update((v) => zoomAt(v, factor));
  return { view, reset: () => setView(FIT_VIEW), zoomBy, stage: handlers };
}

/**
 * Full-window viewer for captured screens: arrows step through them, the wheel
 * and +/− zoom, dragging pans and 0 fits again.
 */
export function ScreenViewer(props: {
  images: ViewerImage[];
  /** The image shown; undefined keeps the viewer closed. */
  index: number | undefined;
  onIndex: (index: number | undefined) => void;
  onOpenExternal: (image: ScreenImage) => void;
}) {
  const zoom = createZoomPan();
  const current = () => (props.index === undefined ? undefined : props.images[props.index]);
  // Before and after of one screen keep the same view, so one spot can be compared.
  const shot = createMemo(() => current()?.shot);
  createEffect(on(shot, zoom.reset));
  const step = (delta: number) => {
    const count = props.images.length;
    if (props.index !== undefined && count) props.onIndex((props.index + delta + count) % count);
  };
  createViewerKeys(() => props.index !== undefined, {
    ArrowLeft: () => step(-1),
    ArrowRight: () => step(1),
    '+': () => zoom.zoomBy(KEY_STEP),
    '=': () => zoom.zoomBy(KEY_STEP),
    '-': () => zoom.zoomBy(1 / KEY_STEP),
    '0': zoom.reset,
  });
  return (
    <Dialog
      open={props.index !== undefined}
      onClose={() => props.onIndex(undefined)}
      ariaLabel="Screenshot viewer"
      width="96vw"
      panelStyle={{ height: '92vh', 'max-height': '92vh', padding: '12px', gap: '8px' }}
    >
      <Show when={current()}>
        {(item) => (
          <>
            <div class="screen-viewer-bar">
              <IconButton
                icon={<ChevronLeftIcon />}
                title="Previous (←)"
                onClick={() => step(-1)}
              />
              <span class="screen-viewer-title">
                {item().label} · <strong>{item().side}</strong>
              </span>
              <span class="screen-viewer-count">
                {(props.index ?? 0) + 1} / {props.images.length}
              </span>
              <IconButton icon={<ChevronRightIcon />} title="Next (→)" onClick={() => step(1)} />
              <span class="screen-viewer-spacer" />
              <IconButton icon="−" title="Zoom out (−)" onClick={() => zoom.zoomBy(1 / KEY_STEP)} />
              <button
                type="button"
                class="screen-viewer-zoom"
                title="Fit to window (0)"
                onClick={zoom.reset}
              >
                {Math.round(zoom.view().scale * 100)}%
              </button>
              <IconButton icon="+" title="Zoom in (+)" onClick={() => zoom.zoomBy(KEY_STEP)} />
              <IconButton
                icon={<ExternalLinkIcon />}
                title="Open in the system viewer"
                onClick={() => props.onOpenExternal(item().image)}
              />
            </div>
            <div
              class="screen-viewer-stage"
              data-zoomed={zoom.view().scale > 1 ? '' : undefined}
              ref={zoom.stage.ref}
              onWheel={zoom.stage.onWheel}
              onPointerDown={zoom.stage.onPointerDown}
              onPointerMove={zoom.stage.onPointerMove}
              onPointerUp={zoom.stage.onPointerUp}
              onPointerCancel={zoom.stage.onPointerUp}
              onDblClick={zoom.stage.onDblClick}
            >
              <img
                src={item().image.dataUrl}
                alt={`${item().label}, ${item().side.toLowerCase()}`}
                draggable={false}
                style={{
                  transform: `translate(${zoom.view().x}px, ${zoom.view().y}px) scale(${zoom.view().scale})`,
                }}
              />
            </div>
            <p class="screen-viewer-hint">
              ← → step through screens · scroll or + − to zoom · drag to pan · double-click or 0 to
              fit
            </p>
          </>
        )}
      </Show>
    </Dialog>
  );
}
