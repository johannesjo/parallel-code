/** A zoomed and panned view: `scale` 1 fits the image; x/y offset it from the centre. */
export interface ZoomView {
  scale: number;
  x: number;
  y: number;
}

export const FIT_VIEW: ZoomView = { scale: 1, x: 0, y: 0 };
const MIN_SCALE = 1;
const MAX_SCALE = 8;

/**
 * Zooms by `factor` keeping `point` (relative to the stage centre) still, so
 * the spot under the cursor stays under it. Back at fit, the image recentres.
 */
export function zoomAt(view: ZoomView, factor: number, point = { x: 0, y: 0 }): ZoomView {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
  if (scale === MIN_SCALE) return FIT_VIEW;
  const ratio = scale / view.scale;
  return {
    scale,
    x: point.x - (point.x - view.x) * ratio,
    y: point.y - (point.y - view.y) * ratio,
  };
}

/** Moves a zoomed view; at fit there is nothing to pan. */
export function panBy(view: ZoomView, dx: number, dy: number): ZoomView {
  return view.scale === MIN_SCALE ? view : { ...view, x: view.x + dx, y: view.y + dy };
}

/** The fitted image's size and the stage's, in CSS pixels. */
export interface ZoomBounds {
  image: { width: number; height: number };
  stage: { width: number; height: number };
}

const limit = (offset: number, image: number, scale: number, stage: number) => {
  const max = Math.max(0, (image * scale - stage) / 2);
  return Math.min(max, Math.max(-max, offset));
};

/** Keeps a zoomed image covering the stage: no dragging it past its own edges. */
export function clampView(view: ZoomView, bounds: ZoomBounds): ZoomView {
  return {
    scale: view.scale,
    x: limit(view.x, bounds.image.width, view.scale, bounds.stage.width),
    y: limit(view.y, bounds.image.height, view.scale, bounds.stage.height),
  };
}
