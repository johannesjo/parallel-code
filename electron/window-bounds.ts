// Where the main window opens on launch.
//
// The renderer saves the window's bounds (`windowState` in state.json) as the
// user moves and resizes it. Applying them here, when the window is created,
// means it opens in place instead of opening at the default size and jumping
// once the renderer has loaded.
//
// Wayland caveat: the compositor places windows there and ignores a client's
// requested position, so only the size and maximized state come back.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InitialWindowBounds {
  bounds: { width: number; height: number; x?: number; y?: number };
  maximized: boolean;
}

const DEFAULT_SIZE = { width: 1400, height: 900 };
// Matches the renderer's MIN_WINDOW_DIMENSION in src/App.tsx.
const MIN_DIMENSION = 100;
// How much of the window must overlap a display for it to count as reachable:
// enough to see it and grab it, not merely a few pixels at the edge.
const MIN_VISIBLE = 100;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parseSaved(rawState: string | null): (Rect & { maximized: boolean }) | null {
  if (!rawState) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawState);
  } catch {
    return null; // loadAppState already validated; a bad file just means defaults
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const ws: unknown = (parsed as Record<string, unknown>).windowState;
  if (!ws || typeof ws !== 'object') return null;
  const { x, y, width, height, maximized } = ws as Record<string, unknown>;
  if (![x, y, width, height].every(isFiniteNumber) || typeof maximized !== 'boolean') return null;
  const rect = { x, y, width, height } as Rect;
  if (rect.width < MIN_DIMENSION || rect.height < MIN_DIMENSION) return null;
  return { ...rect, maximized };
}

function overlapsEnough(a: Rect, b: Rect): boolean {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w >= MIN_VISIBLE && h >= MIN_VISIBLE;
}

/**
 * Initial bounds for the main window from the raw persisted state.
 * `workAreas` are the connected displays' work areas; a saved position that
 * no longer lands on one of them is dropped so the OS places the window.
 */
export function initialWindowBounds(
  rawState: string | null,
  workAreas: readonly Rect[],
): InitialWindowBounds {
  const saved = parseSaved(rawState);
  if (!saved) return { bounds: { ...DEFAULT_SIZE }, maximized: false };
  const { x, y, width, height, maximized } = saved;
  const onScreen = workAreas.some((area) => overlapsEnough(saved, area));
  return { bounds: onScreen ? { x, y, width, height } : { width, height }, maximized };
}
