import { For } from 'solid-js';
import { PROJECT_COLORS } from '../store/store';
import { sectionLabelStyle, theme } from '../lib/theme';

/** Swatches for the project's colour; the selected one is ringed. */
export function ProjectColorPicker(props: { color: string; onChange: (color: string) => void }) {
  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
      <span style={sectionLabelStyle}>Color</span>
      <div
        role="group"
        aria-label="Color"
        style={{ display: 'flex', gap: '8px', 'flex-wrap': 'wrap' }}
      >
        <For each={PROJECT_COLORS}>
          {(color) => {
            const isSelected = () => props.color === color;
            return (
              <button
                type="button"
                aria-label={color}
                aria-pressed={isSelected()}
                onClick={() => props.onChange(color)}
                style={{
                  width: '24px',
                  height: '24px',
                  // Matches ProjectSwatch: the picker previews the
                  // square mark the project will actually show.
                  'border-radius': 'var(--radius-sm)',
                  background: color,
                  border: isSelected() ? `2px solid ${theme.fg}` : '2px solid transparent',
                  outline: isSelected() ? `2px solid ${theme.accent}` : 'none',
                  'outline-offset': '1px',
                  cursor: 'pointer',
                  padding: '0',
                  'flex-shrink': '0',
                }}
              />
            );
          }}
        </For>
      </div>
    </div>
  );
}
