import type { JSX } from 'solid-js';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';

/** Outlined terminal launchers retain a clear boundary without a filled bar. */
export const toolbarBtnStyle = (highlighted: boolean, iconOnly = false): JSX.CSSProperties => ({
  background: 'transparent',
  border: `1px solid ${highlighted ? theme.borderFocus : theme.border}`,
  color: highlighted ? theme.fg : theme.fgMuted,
  cursor: 'pointer',
  'border-radius': 'var(--radius-sm)',
  'box-sizing': 'border-box',
  height: '26px',
  width: iconOnly ? '26px' : undefined,
  padding: iconOnly ? '0' : '0 9px',
  'font-size': sf(12),
  'line-height': '16px',
  display: 'flex',
  'align-items': 'center',
  'justify-content': 'center',
  'flex-shrink': '0',
  gap: '5px',
});
