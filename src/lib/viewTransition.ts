import { debug, error } from './log';
import { prefersMotion } from './reducedMotion';

/**
 * Runs a workspace view change (focus, tiles, board, side panel) as a view
 * transition, so the layouts cross-fade and the task workspace glides to its
 * new box instead of jumping. Terminals resize once, under the animation.
 *
 * With animation the update runs a frame later, after the old layout is
 * captured: callers must not rely on the change having happened on return.
 * `types` name the kind of change so CSS can style it with
 * `:active-view-transition-type()`.
 */
export function withViewTransition(update: () => void, types: string[] = []): void {
  if (!prefersMotion() || !('startViewTransition' in document)) {
    update();
    return;
  }
  const run = () => {
    try {
      update();
    } catch (err) {
      error('view-transition', 'View change failed', err);
    }
  };
  const transition = document.startViewTransition(types.length ? { update: run, types } : run);
  // Rejects when a newer view change skips this animation; the update still ran.
  transition.ready.catch((err: unknown) =>
    debug('view-transition', 'Animation skipped', { reason: String(err) }),
  );
}
