import { For, Show, createEffect, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { createAnchorEffect, placeBelow, type BelowAnchor } from '../lib/floating';
import { CheckIcon, ChevronDownIcon } from './icons';

const MENU_WIDTH = 190;
/** A first guess at the height; the open menu measures itself and is placed again. */
const MENU_HEIGHT = 230;

interface ModelMenuChoice {
  value: string;
  label: string;
  title?: string;
  /** Why the choice cannot be picked now; the row shows it greyed out. */
  disabledReason?: string;
}
interface ModelMenuGroup {
  heading: string;
  choices: ModelMenuChoice[];
  empty?: string;
}
/** A second, independent choice under the models, such as the reasoning level. */
interface ModelMenuSection {
  heading: string;
  choices: ModelMenuChoice[];
  value: string;
  onSelect: (value: string) => void;
}
interface ModelMenuProps {
  label: string;
  /** Visible trigger text; without it the trigger is a bare chevron. */
  text?: string;
  title?: string;
  groups: ModelMenuGroup[];
  value: string;
  onSelect: (value: string) => void;
  onOpen?: () => void;
  section?: ModelMenuSection;
  disabled?: boolean;
  style?: JSX.CSSProperties;
  class?: string;
}

/** One set of choices; a group per set keeps screen readers to one checked row each. */
function MenuGroup(props: { heading: string; children: JSX.Element }) {
  return (
    <div
      role="group"
      aria-label={props.heading}
      style={{ display: 'flex', 'flex-direction': 'column', gap: '1px' }}
    >
      <div
        aria-hidden="true"
        style={{
          padding: '6px 8px 2px',
          'font-size': sf(10),
          'text-transform': 'uppercase',
          'letter-spacing': '0.06em',
          color: theme.fgMuted,
        }}
      >
        {props.heading}
      </div>
      {props.children}
    </div>
  );
}

function MenuRow(props: { choice: ModelMenuChoice; checked: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={props.checked}
      disabled={!!props.choice.disabledReason}
      title={props.choice.title}
      onClick={(e) => {
        e.stopPropagation();
        props.onPick();
      }}
      style={{
        display: 'flex',
        'align-items': 'center',
        gap: '6px',
        padding: '5px 8px',
        background: 'transparent',
        border: 'none',
        'border-radius': 'var(--radius-sm)',
        color: props.choice.disabledReason ? theme.fgMuted : theme.fg,
        cursor: props.choice.disabledReason ? 'default' : 'pointer',
        'text-align': 'left',
        font: 'inherit',
        'font-size': sf(12),
      }}
      onMouseEnter={(e) => {
        if (!props.choice.disabledReason) e.currentTarget.style.background = theme.bgHover;
      }}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {/* The space is reserved on every row, so the labels line up. */}
      <span
        aria-hidden="true"
        style={{
          width: '12px',
          'flex-shrink': '0',
          color: theme.success,
          display: 'inline-flex',
        }}
      >
        <Show when={props.checked}>
          <CheckIcon size={12} />
        </Show>
      </span>
      <span style={{ display: 'flex', 'flex-direction': 'column' }}>
        {props.choice.label}
        <Show when={props.choice.disabledReason}>
          {(reason) => (
            <span style={{ 'font-size': sf(11), color: theme.fgSubtle }}>{reason()}</span>
          )}
        </Show>
      </span>
    </button>
  );
}

function ModelList(
  props: ModelMenuProps & {
    position: BelowAnchor;
    onClose: () => void;
    onMeasure: (height: number) => void;
  },
) {
  let menu: HTMLDivElement | undefined;
  const items = () =>
    Array.from(
      menu?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)') ?? [],
    );

  // Before the first paint, and again when choices arrive while open (Codex
  // models load on open): a menu that opens upwards must end at the trigger.
  // scrollHeight is the whole content even where max-height clips it; 2px of border.
  createEffect(() => {
    void props.groups;
    void props.section;
    if (menu) props.onMeasure(menu.scrollHeight + 2);
  });

  onMount(() => {
    // The chevron that opened the menu gets the focus back when it goes.
    const opener = document.activeElement;
    const list = items();
    const checked = list.find((item) => item.getAttribute('aria-checked') === 'true');
    const frame = requestAnimationFrame(() => (checked ?? list[0])?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        props.onClose();
        return;
      }
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onClose();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const current = items();
      const at = current.indexOf(document.activeElement as HTMLButtonElement);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      current[(at + step + current.length) % current.length]?.focus();
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
      <div
        onClick={(e) => {
          e.stopPropagation();
          props.onClose();
        }}
        onContextMenu={() => props.onClose()}
        style={{ position: 'fixed', inset: '0', 'z-index': 'var(--z-overlay)' }}
      >
        <div
          ref={menu}
          role="menu"
          aria-label={props.label}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: `${props.position.top}px`,
            right: `${props.position.right}px`,
            width: `${MENU_WIDTH}px`,
            'max-height': `${props.position.maxHeight}px`,
            'overflow-y': 'auto',
            background: theme.bgElevated,
            border: `1px solid ${theme.border}`,
            'border-radius': 'var(--radius-md)',
            'box-shadow': '0 6px 20px rgba(0, 0, 0, 0.35)',
            padding: '4px',
            display: 'flex',
            'flex-direction': 'column',
            gap: '1px',
          }}
        >
          <For each={props.groups}>
            {(group) => (
              <MenuGroup heading={group.heading}>
                <Show when={group.empty && group.choices.length === 0}>
                  <div
                    role="presentation"
                    style={{
                      padding: '5px 8px 5px 26px',
                      'font-size': sf(12),
                      color: theme.fgSubtle,
                    }}
                  >
                    {group.empty}
                  </div>
                </Show>
                <For each={group.choices}>
                  {(choice) => (
                    <MenuRow
                      choice={choice}
                      checked={props.value === choice.value}
                      onPick={() => {
                        props.onSelect(choice.value);
                        props.onClose();
                      }}
                    />
                  )}
                </For>
              </MenuGroup>
            )}
          </For>
          <Show when={props.section}>
            {(section) => (
              <MenuGroup heading={section().heading}>
                <For each={section().choices}>
                  {(choice) => (
                    <MenuRow
                      choice={choice}
                      checked={section().value === choice.value}
                      onPick={() => {
                        section().onSelect(choice.value);
                        props.onClose();
                      }}
                    />
                  )}
                </For>
              </MenuGroup>
            )}
          </Show>
        </div>
      </div>
    </Portal>
  );
}

export function ModelMenu(props: ModelMenuProps) {
  const [open, setOpen] = createSignal(false);
  const [position, setPosition] = createSignal<BelowAnchor>({ top: 0, right: 0, maxHeight: 0 });
  const [height, setHeight] = createSignal(MENU_HEIGHT);
  let trigger: HTMLButtonElement | undefined;

  createAnchorEffect(open, () => {
    if (!trigger) return;
    setPosition(
      placeBelow(
        trigger.getBoundingClientRect(),
        MENU_WIDTH,
        { width: window.innerWidth, height: window.innerHeight },
        12,
        height(),
      ),
    );
  });

  return (
    <>
      <button
        ref={trigger}
        type="button"
        // The name includes the visible text, so speech input can target it.
        aria-label={props.text ? `${props.label}: ${props.text}` : props.label}
        aria-haspopup="menu"
        aria-expanded={open()}
        title={props.title ?? props.label}
        disabled={props.disabled}
        class={props.class}
        style={props.style}
        onClick={(event) => {
          // The notes overlay behind the button reacts to clicks of its own.
          event.stopPropagation();
          // Load choices only when the user opens the menu.
          if (!open()) props.onOpen?.();
          setOpen(!open());
        }}
      >
        <Show when={props.text}>
          <span>{props.text}</span>
        </Show>
        <ChevronDownIcon size={12} />
      </button>
      <Show when={open()}>
        <ModelList
          {...props}
          position={position()}
          onClose={() => setOpen(false)}
          onMeasure={setHeight}
        />
      </Show>
    </>
  );
}
