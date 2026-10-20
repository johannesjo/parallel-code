/** Pixel sizes the task columns and the canvas share, so the store can grow a
 *  column by exactly what the canvas takes and the layout draws it that way. */

/** A task column with no user pin. */
export const TASK_TILE_DEFAULT_WIDTH = 520;
/** Narrowest a task column can be dragged. */
export const TASK_TILE_MIN_WIDTH = 300;
/** Room one AI terminal pane needs to stay workable when panes sit side by side.
 *  Adding a pane widens the task column until every pane clears this; the panes
 *  themselves still shrink further when the user drags the column narrower. */
export const AGENT_PANE_MIN_WIDTH = 420;
/** The canvas column opens wide enough for prose, unless the user resized it. */
export const CANVAS_DEFAULT_WIDTH = 400;
/** Narrowest a canvas column can be dragged. */
export const CANVAS_MIN_WIDTH = 320;
