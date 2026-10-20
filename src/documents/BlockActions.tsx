import { For, createEffect, createSignal, onCleanup, type Accessor, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { createAnchorEffect } from '../lib/floating';
import type { ComposerMode } from './store';

/** Passage actions; direct editing is an explicit option in the composer. */
export type BlockActionKind = Exclude<ComposerMode, 'task'>;

interface BlockAction {
  kind: BlockActionKind;
  title: string;
  /** The key that does the same on a selected passage, in the workspace. */
  shortcut?: string;
  /** 16×16 icon path. */
  path: string;
}

/** Labeled passage actions. */
export const BLOCK_ACTIONS: readonly BlockAction[] = [
  {
    kind: 'proposals',
    title: 'Rewrite with AI',
    path: 'M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z',
  },
  {
    kind: 'note',
    title: 'Add comment',
    shortcut: 'C',
    path: 'M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25ZM3.5 6.25a.75.75 0 0 1 .75-.75h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Zm.75 2.25h4a.75.75 0 0 1 0 1.5h-4a.75.75 0 0 1 0-1.5Z',
  },
  {
    kind: 'question',
    title: 'Ask about this passage',
    shortcut: 'A',
    path: 'M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.92 6.085h.001a.749.749 0 1 1-1.342-.67c.169-.339.436-.701.849-.977C6.845 4.16 7.369 4 8 4a2.756 2.756 0 0 1 1.637.525c.503.377.863.965.863 1.725 0 .448-.115.83-.329 1.15-.205.307-.47.513-.692.662-.109.072-.22.138-.313.195l-.006.004a6.24 6.24 0 0 0-.26.16.952.952 0 0 0-.276.245.75.75 0 0 1-1.248-.832c.184-.264.42-.489.692-.661.103-.067.207-.132.313-.195l.007-.004c.1-.061.182-.11.258-.161a.969.969 0 0 0 .277-.245C8.96 6.514 9 6.427 9 6.25a.612.612 0 0 0-.262-.525A1.27 1.27 0 0 0 8 5.5c-.369 0-.595.09-.74.187a1.01 1.01 0 0 0-.34.398ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z',
  },
];

function iconPath(kind: BlockActionKind): string {
  return BLOCK_ACTIONS.find((a) => a.kind === kind)?.path ?? '';
}

/** One action's glyph, shared by the block toolbar and composer. */
export function ActionIcon(props: { kind: BlockActionKind }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d={iconPath(props.kind)} />
    </svg>
  );
}

/** Just inside the block's right edge, level with the markdown column's own inset. */
const RIGHT_INSET = 6;

interface BlockActionsProps {
  floatingUiVisible?: boolean;
  /** The block the toolbar belongs to, on screen; null keeps the bar away. */
  anchor: Accessor<HTMLElement | null>;
  /** A page's § button and markers sit on the right; its toolbar takes the left. */
  alignLeft?: boolean;
  onAction: (kind: BlockActionKind) => void;
  /**
   * Whether a press keeps the focus where it is: over the passage of an open
   * composer, an action switches its mode and takes its text along, and the
   * press must not read as leaving it.
   */
  keepsComposer?: () => boolean;
  /** The pointer moved onto (true) or off (false) the bar itself. */
  onPointer: (inside: boolean) => void;
}

/**
 * Actions for the selected passage, or the block under the pointer.
 * Choosing an action opens the composer; selection itself keeps focus in the prose. One
 * bar serves every block, floating over the window with its bottom edge on
 * the block's top edge: in the gap above the prose, where a click meant for
 * the passage cannot land on an icon, and out of reach of a page whose own
 * CSS clips what its elements contain.
 */
export function BlockActions(props: BlockActionsProps) {
  const [style, setStyle] = createSignal<JSX.CSSProperties | null>(null);
  const open = () => props.floatingUiVisible !== false && props.anchor() !== null;
  function place() {
    const rect = props.anchor()?.getBoundingClientRect();
    if (!rect) return setStyle(null);
    setStyle(
      props.alignLeft
        ? { top: `${rect.top}px`, left: `${rect.left}px` }
        : { top: `${rect.top}px`, right: `${window.innerWidth - rect.right + RIGHT_INSET}px` },
    );
  }
  createAnchorEffect(open, place);
  createEffect(() => {
    const anchor = props.anchor();
    if (!open() || !anchor) return;
    const observer = new ResizeObserver(place);
    observer.observe(anchor);
    onCleanup(() => observer.disconnect());
  });
  return (
    <Portal>
      <span
        class="docws-block-actions"
        inert={props.floatingUiVisible === false}
        classList={{ 'is-open': open() && style() !== null }}
        role="toolbar"
        aria-label="Block actions"
        style={{
          ...style(),
          visibility: props.floatingUiVisible === false ? 'hidden' : undefined,
          transition: props.floatingUiVisible === false ? 'none' : undefined,
        }}
        onMouseEnter={() => props.onPointer(true)}
        onMouseLeave={() => props.onPointer(false)}
      >
        <For each={BLOCK_ACTIONS}>
          {(action) => (
            <button
              type="button"
              class="docws-block-action"
              data-kind={action.kind}
              aria-label={action.title}
              aria-keyshortcuts={action.shortcut}
              title={action.shortcut ? `${action.title} (${action.shortcut})` : undefined}
              onMouseDown={(e) => {
                if (props.keepsComposer?.()) e.preventDefault();
              }}
              onClick={(e) => {
                e.stopPropagation();
                props.onAction(action.kind);
              }}
            >
              <ActionIcon kind={action.kind} />
              <span>
                {action.kind === 'proposals'
                  ? 'Rewrite'
                  : action.kind === 'question'
                    ? 'Ask'
                    : 'Comment'}
              </span>
            </button>
          )}
        </For>
      </span>
    </Portal>
  );
}
