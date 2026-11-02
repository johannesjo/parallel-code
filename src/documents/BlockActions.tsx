import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  type Accessor,
  type Component,
  type JSX,
} from 'solid-js';
import { Portal } from 'solid-js/web';
import { createAnchorEffect } from '../lib/floating';
import type { ComposerMode } from './store';
import { GitGraphIcon, NoteIcon, QuestionIcon } from '../components/icons';

/** Passage actions; direct editing is an explicit option in the composer. */
export type BlockActionKind = Exclude<ComposerMode, 'task'>;

interface BlockAction {
  kind: BlockActionKind;
  title: string;
  /** The key that does the same on a selected passage, in the workspace. */
  shortcut?: string;
  /** The action's glyph, the app's shared icon-module component for it. */
  icon: Component<{ size?: number | string }>;
}

/** Labeled passage actions. */
export const BLOCK_ACTIONS: readonly BlockAction[] = [
  {
    kind: 'proposals',
    title: 'Rewrite with AI',
    icon: GitGraphIcon,
  },
  {
    kind: 'note',
    title: 'Add comment',
    shortcut: 'C',
    icon: NoteIcon,
  },
  {
    kind: 'question',
    title: 'Ask about this passage',
    shortcut: 'A',
    icon: QuestionIcon,
  },
];

/** One action's glyph, shared by the block toolbar and composer. */
export function ActionIcon(props: { kind: BlockActionKind }) {
  const icon = () => BLOCK_ACTIONS.find((a) => a.kind === props.kind)?.icon;
  return (
    <Show when={icon()} keyed>
      {(Icon) => <Icon size={14} />}
    </Show>
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
