import { For } from 'solid-js';
import { theme } from '../lib/theme';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  title?: string;
}

interface SegmentedButtonsProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

/**
 * Roving-tabindex segmented button group.
 * Only the active option is in the Tab order; Arrow keys move between options.
 */
export function SegmentedButtons<T extends string>(props: SegmentedButtonsProps<T>) {
  const btnRefs: HTMLButtonElement[] = [];

  function handleKeyDown(e: KeyboardEvent, idx: number) {
    const opts = props.options;
    let nextIdx: number | null = null;

    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      // Find next non-disabled option
      for (let i = 1; i <= opts.length; i++) {
        const candidate = (idx + i) % opts.length;
        if (!opts[candidate].disabled) {
          nextIdx = candidate;
          break;
        }
      }
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      for (let i = 1; i <= opts.length; i++) {
        const candidate = (idx - i + opts.length) % opts.length;
        if (!opts[candidate].disabled) {
          nextIdx = candidate;
          break;
        }
      }
    }

    if (nextIdx !== null) {
      props.onChange(opts[nextIdx].value);
      btnRefs[nextIdx]?.focus();
    }
  }

  return (
    <div role="radiogroup" style={{ display: 'flex', gap: '4px' }}>
      <For each={props.options}>
        {(opt, i) => {
          const isActive = () => props.value === opt.value;
          return (
            <button
              ref={(el) => (btnRefs[i()] = el)}
              type="button"
              role="radio"
              aria-checked={isActive()}
              disabled={opt.disabled}
              tabIndex={isActive() ? 0 : -1}
              title={opt.title}
              onClick={() => !opt.disabled && props.onChange(opt.value)}
              onKeyDown={(e) => handleKeyDown(e, i())}
              style={{
                flex: '1',
                padding: '6px 12px',
                'font-size': '13px',
                'border-radius': '6px',
                border: `1px solid ${isActive() ? theme.accent : theme.border}`,
                background: isActive()
                  ? `color-mix(in srgb, ${theme.accent} 15%, transparent)`
                  : theme.bgInput,
                color: isActive() ? theme.accent : theme.fgMuted,
                cursor: opt.disabled ? 'not-allowed' : 'pointer',
                opacity: opt.disabled ? '0.5' : '1',
                'font-weight': isActive() ? '600' : '400',
              }}
            >
              {opt.label}
            </button>
          );
        }}
      </For>
    </div>
  );
}
