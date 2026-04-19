import type { JSX } from 'solid-js';

export const badgeStyle = (color: string): JSX.CSSProperties => ({
  'font-size': '12px',
  'font-weight': '600',
  padding: '2px 8px',
  'border-radius': '4px',
  background: `color-mix(in srgb, ${color} 15%, transparent)`,
  color: color,
  border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`,
  'flex-shrink': '0',
  'white-space': 'nowrap',
});
