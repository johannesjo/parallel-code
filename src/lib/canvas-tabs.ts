/** Pure helpers for the canvas tab strip; the store applies their results. */
import type { CanvasTab, Task } from '../store/types';

/** The canvas column is on screen while a tab is open or the user asked for it. */
export function isTaskCanvasVisible(task: Pick<Task, 'canvasOpen' | 'canvasTabs'>): boolean {
  return !!task.canvasOpen || (task.canvasTabs?.length ?? 0) > 0;
}

/** A tab is the thing it shows: the same file twice is one tab. */
export const canvasTabKey = (tab: CanvasTab): string => `${tab.kind}:${tab.path}`;

/** The tab a key stands for; the path may itself contain colons. */
export function tabFromKey(key: string): CanvasTab | null {
  const at = key.indexOf(':');
  if (at === -1) return null;
  const kind = key.slice(0, at);
  return kind === 'markdown' ? { kind, path: key.slice(at + 1) } : null;
}

/** `tabs` with `tab` added at the end unless it is already there. */
export function withTab(tabs: CanvasTab[], tab: CanvasTab): CanvasTab[] {
  const key = canvasTabKey(tab);
  return tabs.some((t) => canvasTabKey(t) === key) ? tabs : [...tabs, tab];
}

/** `tabs` without the tab `key`, and which tab should be in front afterwards:
 *  the one that was, else the neighbour on the left, else the new first. */
export function withoutTab(
  tabs: CanvasTab[],
  active: string | undefined,
  key: string,
): { tabs: CanvasTab[]; active: string | undefined } {
  const index = tabs.findIndex((t) => canvasTabKey(t) === key);
  if (index === -1) return { tabs, active };
  const rest = tabs.filter((_, i) => i !== index);
  if (rest.length === 0) return { tabs: rest, active: undefined };
  if (active !== undefined && active !== key) return { tabs: rest, active };
  return { tabs: rest, active: canvasTabKey(rest[Math.max(0, index - 1)]) };
}
