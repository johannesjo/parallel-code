// Whether a terminal pane is on screen, i.e. worth holding a WebGL context for.
//
// Every task's terminals stay mounted (their pty sessions and scrollback must
// survive layout changes), so with many tasks the app would otherwise hold one
// live WebGL context per pane — far beyond Chromium's active-context cap, which
// then evicts contexts in rotation (see max-active-webgl-contexts in
// electron/main.ts and the recovery policy in webglContextLoss.ts). Panes that
// are not on screen fall back to xterm's DOM renderer instead and reacquire a
// WebGL context when they come back, keeping live contexts ≈ visible panes.
//
// Three things hide a pane:
// - focus mode shows one task; the others sit under it with visibility:hidden,
// - tiling mode scrolls tasks horizontally; TilingLayout tracks which are
//   fully off screen (partially visible counts as visible),
// - tabs within a task show one agent pane at a time.

import type { TaskViewportVisibility } from '../store/types';

export interface PaneVisibilityInput {
  focusMode: boolean;
  activeTaskId: string | null;
  taskId: string;
  /** TilingLayout's measurement; undefined while unmeasured (treated as visible). */
  viewportVisibility: TaskViewportVisibility | undefined;
  /** Pane-level visibility within the task (tabs); undefined means visible. */
  paneVisible?: boolean;
  /** The pane is not a task panel (e.g. an arena competitor rendered in an
   *  overlay): task-level focus/tiling state says nothing about it, so only
   *  `paneVisible` applies. */
  standalone?: boolean;
}

export function isTerminalPaneOnScreen(input: PaneVisibilityInput): boolean {
  if (input.paneVisible === false) return false;
  if (input.standalone) return true;
  if (input.focusMode) return input.activeTaskId === input.taskId;
  return (
    input.viewportVisibility !== 'offscreen-left' && input.viewportVisibility !== 'offscreen-right'
  );
}

/** How long a pane stays on WebGL after leaving the screen. Absorbs brief
 *  flickers (a horizontal scroll passing over a pane, a quick tab round-trip)
 *  so a context is not torn down and rebuilt for nothing. */
export const WEBGL_DETACH_DELAY_MS = 1000;
