import { For } from 'solid-js';
import { theme } from '../lib/theme';

export interface DialogTab<T extends string> {
  id: T;
  label: string;
}

interface DialogTabsProps<T extends string> {
  tabs: DialogTab<T>[];
  active: T;
  onChange: (id: T) => void;
  /** Prefix for tab and panel ids; panels use `${idPrefix}-panel-${id}`. */
  idPrefix: string;
  label: string;
}

export const dialogTabPanelId = (idPrefix: string, id: string) => `${idPrefix}-panel-${id}`;
export const dialogTabId = (idPrefix: string, id: string) => `${idPrefix}-tab-${id}`;

/** Underlined tab strip for dialogs; arrow keys, Home and End move between tabs. */
export function DialogTabs<T extends string>(props: DialogTabsProps<T>) {
  let listRef: HTMLDivElement | undefined;

  function select(next: T) {
    props.onChange(next);
    listRef?.querySelector<HTMLElement>(`#${dialogTabId(props.idPrefix, next)}`)?.focus();
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={props.label}
      style={{
        'flex-shrink': '0',
        display: 'flex',
        gap: '2px',
        'border-bottom': `1px solid ${theme.border}`,
      }}
    >
      <For each={props.tabs}>
        {(tab) => {
          const selected = () => props.active === tab.id;
          return (
            <button
              role="tab"
              type="button"
              id={dialogTabId(props.idPrefix, tab.id)}
              aria-selected={selected()}
              aria-controls={dialogTabPanelId(props.idPrefix, tab.id)}
              tabIndex={selected() ? 0 : -1}
              onClick={() => props.onChange(tab.id)}
              onKeyDown={(e) => {
                const ids = props.tabs.map((t) => t.id);
                const at = ids.indexOf(tab.id);
                const next =
                  e.key === 'ArrowRight'
                    ? ids[(at + 1) % ids.length]
                    : e.key === 'ArrowLeft'
                      ? ids[(at - 1 + ids.length) % ids.length]
                      : e.key === 'Home'
                        ? ids[0]
                        : e.key === 'End'
                          ? ids[ids.length - 1]
                          : undefined;
                if (next === undefined) return;
                e.preventDefault();
                select(next);
              }}
              style={{
                background: 'transparent',
                border: 'none',
                'border-bottom': `2px solid ${selected() ? theme.accent : 'transparent'}`,
                // Same weight either way: a bolder label would widen the tab
                // and nudge its neighbours on every switch.
                color: selected() ? theme.fg : theme.fgMuted,
                cursor: 'pointer',
                'font-size': '14px',
                padding: '6px 14px',
                'margin-bottom': '-1px',
                'border-radius': '0',
                transition: 'color 0.15s, border-color 0.15s',
              }}
            >
              {tab.label}
            </button>
          );
        }}
      </For>
    </div>
  );
}
