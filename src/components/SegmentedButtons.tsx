import { For } from 'solid-js';
import { theme } from '../lib/theme';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface SegmentedButtonsProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

export function SegmentedButtons<T extends string>(props: SegmentedButtonsProps<T>) {
  return (
    <div style={{ display: 'flex', gap: '4px' }}>
      <For each={props.options}>
        {(opt) => {
          const isActive = () => props.value === opt.value;
          return (
            <button
              type="button"
              disabled={opt.disabled}
              onClick={() => !opt.disabled && props.onChange(opt.value)}
              style={{
                flex: '1',
                padding: '6px 12px',
                'font-size': '12px',
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
