/**
 * Keyboard navigation shared by the understanding tour dialog and the change
 * tour sidebar: each key maps the current step and the last index to a target
 * step, which the controller clamps.
 */
export const TOUR_KEYS: Record<string, (step: number, last: number) => number> = {
  ArrowLeft: (step) => step - 1,
  ArrowRight: (step) => step + 1,
  Home: () => 0,
  End: (_step, last) => last,
};

/** Keys typed into a field move its caret, never the tour. */
export function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  );
}
