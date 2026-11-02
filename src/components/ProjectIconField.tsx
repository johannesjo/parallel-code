import { For, Show } from 'solid-js';
import { theme, sectionLabelStyle } from '../lib/theme';
import { PROJECT_ICON_GROUPS, type ProjectIconId } from '../lib/project-icon';
import { ProjectIconGlyph } from './ProjectIconGlyph';

const label = (id: ProjectIconId) => id.replace(/-/g, ' ');

/** Optional glyph that replaces a project's color square wherever it is shown. */
export function ProjectIconField(props: {
  icon: ProjectIconId | undefined;
  /** Previews each glyph in the color the project will show it in. */
  color: string;
  onChange: (icon: ProjectIconId | undefined) => void;
}) {
  const choiceStyle = (selected: boolean) => ({
    width: '28px',
    height: '28px',
    display: 'inline-flex',
    'align-items': 'center',
    'justify-content': 'center',
    padding: '0',
    cursor: 'pointer',
    background: 'transparent',
    'border-radius': 'var(--radius-sm)',
    // Same weight either way so selecting never shifts the grid.
    border: `2px solid ${selected ? theme.fg : 'transparent'}`,
  });
  const square = () => (
    <span
      style={{ width: '10px', height: '10px', 'border-radius': '2px', background: props.color }}
    />
  );

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
      <label style={sectionLabelStyle}>Icon</label>
      {/* Collapsed by default: 100+ glyphs would push the rest of the settings far down. */}
      <details>
        <summary
          // Default display, not flex: flex drops the disclosure triangle that says it opens.
          style={{ cursor: 'pointer', color: theme.fgMuted, 'font-size': '13px' }}
        >
          <span
            style={{
              display: 'inline-flex',
              'vertical-align': 'middle',
              margin: '0 6px 0 2px',
              color: props.color,
            }}
          >
            <Show when={props.icon} fallback={square()}>
              {(icon) => <ProjectIconGlyph icon={icon()} size={16} />}
            </Show>
          </span>
          {props.icon ? label(props.icon) : 'No icon'}
        </summary>
        <div
          style={{ display: 'flex', 'flex-direction': 'column', gap: '8px', 'padding-top': '8px' }}
        >
          <button
            type="button"
            aria-pressed={props.icon === undefined}
            title="Show the color square instead of an icon"
            onClick={() => props.onChange(undefined)}
            style={{
              ...choiceStyle(props.icon === undefined),
              width: 'auto',
              'align-self': 'flex-start',
              gap: '6px',
              padding: '0 8px',
              color: theme.fg,
              'font-size': '12px',
              // A plain border so it reads as a button, not a caption.
              border: `2px solid ${props.icon === undefined ? theme.fg : theme.border}`,
            }}
          >
            {square()}
            No icon
          </button>
          <For each={PROJECT_ICON_GROUPS}>
            {(group) => (
              <fieldset style={{ border: 'none', margin: '0', padding: '0' }}>
                <legend style={{ 'font-size': '11px', color: theme.fgSubtle, padding: '0 0 4px' }}>
                  {group.label}
                </legend>
                <div style={{ display: 'flex', gap: '2px', 'flex-wrap': 'wrap' }}>
                  <For each={group.ids}>
                    {(id) => (
                      <button
                        type="button"
                        aria-pressed={props.icon === id}
                        aria-label={`${label(id)} icon`}
                        title={label(id)}
                        onClick={() => props.onChange(id)}
                        style={{ ...choiceStyle(props.icon === id), color: props.color }}
                      >
                        <ProjectIconGlyph icon={id} size={16} />
                      </button>
                    )}
                  </For>
                </div>
              </fieldset>
            )}
          </For>
        </div>
      </details>
    </div>
  );
}
