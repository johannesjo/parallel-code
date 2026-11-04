import type { JSX } from 'solid-js';

const badgeBase: JSX.CSSProperties = {
  'font-size': '12px',
  'font-weight': '600',
  padding: '2px 8px',
  'border-radius': 'var(--radius-xs)',
  'flex-shrink': '0',
  'white-space': 'nowrap',
};

/** Tinted badge for state that needs attention now (failures, review, risk). */
export const badgeStyle = (color: string): JSX.CSSProperties => ({
  ...badgeBase,
  background: `color-mix(in srgb, ${color} 15%, transparent)`,
  color: color,
  border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`,
});

/** Plain badge for routine info; colour is reserved for urgency. */
export const neutralBadgeStyle: JSX.CSSProperties = {
  ...badgeBase,
  background: 'transparent',
  color: 'var(--fg-muted)',
  border: '1px solid var(--border)',
};

/**
 * The box every chip in the task header's branch row shares: one height and
 * one centred line, so tinted badges, buttons and warnings line up.
 * `.task-pr-merge` in styles.css mirrors it.
 */
export const rowChipBox: JSX.CSSProperties = {
  display: 'inline-flex',
  'align-items': 'center',
  'box-sizing': 'border-box',
  height: '18px',
  padding: '0 6px',
  'font-size': '11px',
  'line-height': '1',
};
