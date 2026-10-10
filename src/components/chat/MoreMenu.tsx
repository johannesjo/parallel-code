import { For, Show, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { ChevronRightIcon, KebabIcon } from '../icons';
import './MoreMenu.css';
import { createAnchorEffect, placeBelow, type BelowAnchor } from '../../lib/floating';

interface MenuEntry {
  label: string;
  icon?: JSX.Element;
  title?: string;
  /** A keyboard shortcut shown beside the label. */
  hint?: string;
  disabled?: boolean;
  /** Items sharing a group are listed under it as a heading. */
  group?: string;
}

type MenuAction = MenuEntry & { run: () => void; children?: never };
type Submenu = MenuEntry & { children: MenuAction[]; run?: never };
export type MoreMenuItem = MenuAction | Submenu;

function MenuButtons(props: {
  items: MoreMenuItem[];
  expanded?: MoreMenuItem;
  onSelect: (item: MoreMenuItem, button: HTMLButtonElement) => void;
  onHover?: (item: MoreMenuItem, button: HTMLButtonElement) => void;
}) {
  return (
    <For each={props.items}>
      {(item, index) => (
        <>
          <Show when={item.group && item.group !== props.items[index() - 1]?.group}>
            <div class="chat-menu-group" role="presentation">
              {item.group}
            </div>
          </Show>
          <button
            type="button"
            role="menuitem"
            title={item.title}
            disabled={item.disabled}
            aria-haspopup={item.children ? 'menu' : undefined}
            aria-expanded={item.children ? props.expanded === item : undefined}
            onMouseEnter={(event) => props.onHover?.(item, event.currentTarget)}
            onClick={(event) => props.onSelect(item, event.currentTarget)}
          >
            <span class="chat-menu-caption">
              <Show when={item.icon}>
                {(icon) => (
                  <span class="chat-menu-icon" aria-hidden="true">
                    {icon()}
                  </span>
                )}
              </Show>
              <span class="chat-menu-label">{item.label}</span>
            </span>
            <Show
              when={item.children}
              fallback={
                <Show when={item.hint}>
                  <kbd>{item.hint}</kbd>
                </Show>
              }
            >
              <ChevronRightIcon size={12} />
            </Show>
          </button>
        </>
      )}
    </For>
  );
}

const MENU_WIDTH = 220;
/** Roughly the height of one entry and of the menu's padding, from MoreMenu.css. */
const ITEM_HEIGHT = 27;
const MENU_PADDING = 10;

function MenuList(props: {
  items: MoreMenuItem[];
  position: BelowAnchor;
  label: string;
  onClose: () => void;
}) {
  let menu: HTMLDivElement | undefined;
  let submenu: HTMLDivElement | undefined;
  const [branch, setBranch] = createSignal<{ item: Submenu; button: HTMLButtonElement }>();
  const [branchPosition, setBranchPosition] = createSignal({ top: 0, left: 0, maxHeight: 0 });
  const entries = (panel = menu) =>
    Array.from(
      panel?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );

  createAnchorEffect(
    () => Boolean(branch()),
    () => {
      const current = branch();
      if (!current) return;
      const anchor = current.button.getBoundingClientRect();
      const height = current.item.children.length * ITEM_HEIGHT + MENU_PADDING;
      const left =
        anchor.right + MENU_WIDTH + 12 <= window.innerWidth
          ? anchor.right
          : anchor.left - MENU_WIDTH;
      const top = Math.max(12, Math.min(anchor.top, window.innerHeight - height - 12));
      setBranchPosition({
        left: Math.max(12, Math.min(left, window.innerWidth - MENU_WIDTH - 12)),
        top,
        maxHeight: Math.max(0, window.innerHeight - top - 12),
      });
    },
  );

  function openBranch(item: MoreMenuItem, button: HTMLButtonElement, focus: boolean) {
    if (!item.children || item.disabled) {
      setBranch(undefined);
      return;
    }
    setBranch({ item, button });
    if (focus)
      queueMicrotask(() => {
        if (submenu?.isConnected && button.getAttribute('aria-expanded') === 'true') {
          entries(submenu)[0]?.focus();
        }
      });
  }

  function select(item: MoreMenuItem, button: HTMLButtonElement) {
    if (item.children) {
      openBranch(item, button, true);
      return;
    }
    // Restore trigger focus before the action is allowed to move it elsewhere.
    props.onClose();
    item.run();
  }

  onMount(() => {
    // The button that opened the menu gets the focus back when it goes.
    const opener = document.activeElement;
    const frame = requestAnimationFrame(() => entries()[0]?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        props.onClose();
        return;
      }
      if (event.key === 'Escape' || (event.key === 'ArrowLeft' && branch())) {
        event.preventDefault();
        event.stopPropagation();
        const current = branch();
        if (current) {
          setBranch(undefined);
          current.button.focus();
        } else props.onClose();
        return;
      }
      if (event.key === 'ArrowRight') {
        const focused = document.activeElement;
        if (
          focused instanceof HTMLButtonElement &&
          menu?.contains(focused) &&
          focused.getAttribute('aria-haspopup') === 'menu'
        ) {
          event.preventDefault();
          event.stopPropagation();
          focused.click();
        }
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const inSubmenu = submenu?.contains(document.activeElement);
      const list = entries(inSubmenu ? submenu : menu);
      if (!inSubmenu) setBranch(undefined);
      const at = list.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      list[(at + step + list.length) % list.length]?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKey, true);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    });
  });
  return (
    <Portal>
      <div class="chat-menu-backdrop" onClick={() => props.onClose()}>
        <div
          ref={menu}
          class="chat-menu"
          role="menu"
          aria-label={props.label}
          onClick={(event) => event.stopPropagation()}
          style={{
            top: `${props.position.top}px`,
            right: `${props.position.right}px`,
            width: `${MENU_WIDTH}px`,
            'max-height': `${props.position.maxHeight}px`,
          }}
        >
          <MenuButtons
            items={props.items}
            expanded={branch()?.item}
            onSelect={select}
            onHover={(item, button) => openBranch(item, button, false)}
          />
        </div>
        <Show when={branch()}>
          {(current) => (
            <div
              ref={submenu}
              class="chat-menu"
              role="menu"
              aria-label={current().item.label}
              onClick={(event) => event.stopPropagation()}
              style={{
                top: `${branchPosition().top}px`,
                left: `${branchPosition().left}px`,
                width: `${MENU_WIDTH}px`,
                'max-height': `${branchPosition().maxHeight}px`,
              }}
            >
              <MenuButtons items={current().item.children} onSelect={select} />
            </div>
          )}
        </Show>
      </div>
    </Portal>
  );
}

/** An action menu with an optional labelled trigger. */
export function MoreMenu(props: {
  items: MoreMenuItem[];
  label?: string;
  icon?: JSX.Element;
  class?: string;
}) {
  let button: HTMLButtonElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [position, setPosition] = createSignal<BelowAnchor>({ top: 0, right: 0, maxHeight: 0 });
  createAnchorEffect(open, () => {
    if (!button) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    // Room the menu needs; placeBelow flips it above the button near the window's foot.
    const height = props.items.length * ITEM_HEIGHT + MENU_PADDING;
    setPosition(placeBelow(button.getBoundingClientRect(), MENU_WIDTH, viewport, 12, height));
  });
  return (
    <>
      <button
        ref={button}
        type="button"
        class={props.class ?? 'chat-more'}
        aria-label={props.label ?? 'More actions'}
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open());
        }}
      >
        <Show when={props.label} fallback={<KebabIcon size={14} />}>
          {props.icon}
          {props.label}
        </Show>
      </button>
      <Show when={open()}>
        <MenuList
          items={props.items}
          position={position()}
          label={props.label ?? 'More actions'}
          onClose={() => setOpen(false)}
        />
      </Show>
    </>
  );
}
