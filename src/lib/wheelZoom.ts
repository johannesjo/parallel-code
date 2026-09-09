const LINE_DELTA_PX = 16;
const PAGE_DELTA_PX = 800;
const ZOOM_STEP_DELTA_PX = 100;

function toPixels(e: WheelEvent, delta = e.deltaY): number {
  switch (e.deltaMode) {
    case WheelEvent.DOM_DELTA_LINE:
      return delta * LINE_DELTA_PX;
    case WheelEvent.DOM_DELTA_PAGE:
      return delta * PAGE_DELTA_PX;
    default:
      return delta;
  }
}

interface CtrlWheelZoomOptions {
  stopPropagation?: boolean;
}

export function createCtrlWheelZoomHandler(
  onStep: (delta: 1 | -1) => void,
  options: CtrlWheelZoomOptions = {},
): (e: WheelEvent) => void {
  let remainderPx = 0;

  return (e: WheelEvent) => {
    if (!e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    if (options.stopPropagation) e.stopPropagation();

    const deltaPx = toPixels(e);
    if (remainderPx !== 0 && Math.sign(remainderPx) !== Math.sign(deltaPx)) {
      remainderPx = 0;
    }
    remainderPx += deltaPx;

    const steps = Math.trunc(remainderPx / ZOOM_STEP_DELTA_PX);
    if (steps === 0) return;

    const direction: 1 | -1 = steps < 0 ? 1 : -1;
    for (let i = 0; i < Math.abs(steps); i += 1) onStep(direction);
    remainderPx -= steps * ZOOM_STEP_DELTA_PX;
  };
}

const RESIZE_STEP_PX = 30;

export function createCtrlShiftWheelResizeHandler(
  onStep: (deltaPx: number) => void,
): (e: WheelEvent) => void {
  let remainderPx = 0;

  return (e: WheelEvent) => {
    if (!e.ctrlKey || !e.shiftKey) return;
    e.preventDefault();

    // macOS reports Shift+wheel as horizontal scrolling.
    const deltaPx = toPixels(e, e.deltaY || e.deltaX);
    if (remainderPx !== 0 && Math.sign(remainderPx) !== Math.sign(deltaPx)) {
      remainderPx = 0;
    }
    remainderPx += deltaPx;

    const steps = Math.trunc(remainderPx / ZOOM_STEP_DELTA_PX);
    if (steps === 0) return;

    onStep(-steps * RESIZE_STEP_PX);
    remainderPx -= steps * ZOOM_STEP_DELTA_PX;
  };
}
