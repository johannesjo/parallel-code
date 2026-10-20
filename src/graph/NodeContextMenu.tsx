import { createEffect, createSignal, Index, onCleanup, onMount, Show, untrack } from 'solid-js';
import { Dynamic, Portal } from 'solid-js/web';
import type { JSX } from 'solid-js';

export interface NodeAction {
  label: string;
  /** Leading glyph; items without one keep the column so labels stay aligned. */
  icon?: (props: { size?: number | string }) => JSX.Element;
  shortcut?: string;
  /** Explains a disabled item; shown as a native tooltip. */
  title?: string;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  /** Draws a divider above this item. */
  separator?: boolean;
  children?: NodeAction[];
  run?: () => void;
}

export function NodeContextMenu(props: {
  anchor: { x: number; y: number };
  actions: NodeAction[];
  label?: string;
  /** The control that opened the menu; clicking it again toggles instead of reopening. */
  owner?: Element;
  onClose: () => void;
}) {
  let menu!: HTMLDivElement;
  let submenu: HTMLDivElement | undefined;
  const [position, setPosition] = createSignal(untrack(() => props.anchor));
  const [group, setGroup] = createSignal<{
    action: NodeAction;
    anchor: HTMLButtonElement;
    focus: boolean;
  }>();
  const [subPosition, setSubPosition] = createSignal({ x: 0, y: 0 });
  const items = (element: HTMLElement) =>
    [...element.children].filter(
      (child): child is HTMLButtonElement => child instanceof HTMLButtonElement && !child.disabled,
    );
  createEffect(() => {
    const current = group();
    if (!current || !submenu) return;
    const bounds = submenu.getBoundingClientRect();
    const parent = menu.getBoundingClientRect();
    const anchor = current.anchor.getBoundingClientRect();
    setSubPosition({
      x: Math.max(
        8,
        Math.min(
          parent.right + bounds.width <= window.innerWidth - 8
            ? parent.right
            : parent.left - bounds.width,
          window.innerWidth - bounds.width - 8,
        ),
      ),
      y: Math.max(8, Math.min(anchor.top, window.innerHeight - bounds.height - 8)),
    });
    if (current.focus)
      (
        submenu.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? items(submenu)[0]
      )?.focus({ preventScroll: true });
  });
  // The open group is stored by reference; re-read it so rebuilt lists keep radio states current.
  const groupAction = () => {
    const current = group();
    return (
      current && (props.actions.find((a) => a.label === current.action.label) ?? current.action)
    );
  };
  function back() {
    const anchor = group()?.anchor;
    setGroup(undefined);
    anchor?.focus();
  }
  function choose(action: NodeAction, anchor: HTMLButtonElement) {
    if (action.children) setGroup({ action, anchor, focus: true });
    else {
      props.onClose();
      action.run?.();
    }
  }
  onMount(() => {
    const bounds = menu.getBoundingClientRect();
    setPosition({
      x: Math.max(8, Math.min(props.anchor.x, window.innerWidth - bounds.width - 8)),
      y: Math.max(8, Math.min(props.anchor.y, window.innerHeight - bounds.height - 8)),
    });
    items(menu)[0]?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menu.contains(event.target) &&
        !props.owner?.contains(event.target)
      )
        props.onClose();
    };
    const close = () => props.onClose();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', close);
    onCleanup(() => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', close);
    });
  });
  // Buttons read their action through props: the list is rebuilt on every document
  // change, and remounting buttons would drop keyboard focus mid-menu.
  function ActionButton(item: { action: NodeAction; child?: boolean }) {
    return (
      <>
        <Show when={item.action.separator}>
          <hr role="separator" />
        </Show>
        <button
          type="button"
          role={item.action.checked === undefined ? 'menuitem' : 'menuitemradio'}
          aria-checked={item.action.checked}
          aria-haspopup={item.action.children ? 'menu' : undefined}
          aria-expanded={
            item.action.children ? group()?.action.label === item.action.label : undefined
          }
          tabIndex={-1}
          disabled={item.action.disabled}
          title={item.action.title}
          data-danger={item.action.danger}
          onPointerEnter={(event) => {
            if (item.child) return;
            if (item.action.children)
              setGroup({ action: item.action, anchor: event.currentTarget, focus: false });
            else setGroup(undefined);
          }}
          onClick={(event) => choose(item.action, event.currentTarget)}
        >
          <span>
            <i class="mindmap-menu-icon" aria-hidden="true">
              <Show when={item.action.icon}>
                {(icon) => <Dynamic component={icon()} size={12} />}
              </Show>
            </i>
            {item.action.label}
          </span>
          <small>
            {item.action.checked ? '✓' : item.action.children ? '›' : item.action.shortcut}
          </small>
        </button>
      </>
    );
  }
  return (
    <Portal>
      <div
        ref={menu}
        class="mindmap-context-menu"
        role="menu"
        aria-label={props.label ?? 'Node actions'}
        style={{ left: `${position().x}px`, top: `${position().y}px` }}
        onContextMenu={(event) => event.preventDefault()}
        onPointerLeave={(event) => {
          if (!(event.relatedTarget instanceof Node) || !menu.contains(event.relatedTarget))
            setGroup(undefined);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          const inSubmenu =
            group() && event.target instanceof Node && submenu?.contains(event.target);
          if (inSubmenu && (event.key === 'ArrowLeft' || event.key === 'Escape')) {
            event.preventDefault();
            back();
          } else if (!inSubmenu && event.key === 'ArrowRight') {
            const anchor = document.activeElement;
            const action = props.actions.find(
              (action) => action.label === anchor?.querySelector('span')?.textContent,
            );
            if (action?.children && anchor instanceof HTMLButtonElement) {
              event.preventDefault();
              choose(action, anchor);
            }
          } else if (event.key === 'Escape' || event.key === 'Tab') {
            event.preventDefault();
            props.onClose();
          } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const list = items(inSubmenu && submenu ? submenu : menu);
            const index = list.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? list.length - 1
                  : (index + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
            list[next]?.focus();
          }
        }}
      >
        <Index each={props.actions}>{(action) => <ActionButton action={action()} />}</Index>
        <Show when={group()}>
          {(current) => (
            <div
              ref={submenu}
              class="mindmap-context-menu"
              role="menu"
              aria-label={current().action.label}
              style={{ left: `${subPosition().x}px`, top: `${subPosition().y}px` }}
            >
              <Index each={groupAction()?.children ?? current().action.children}>
                {(action) => <ActionButton action={action()} child />}
              </Index>
            </div>
          )}
        </Show>
      </div>
    </Portal>
  );
}
