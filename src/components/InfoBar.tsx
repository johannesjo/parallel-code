import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import type { JSX } from 'solid-js';

interface InfoBarProps {
  children: JSX.Element;
  onClick?: (e?: MouseEvent) => void;
  onDblClick?: () => void;
  title?: string;
  class?: string;
  allowOverflow?: boolean;
  compact?: boolean;
  style?: JSX.CSSProperties;
}

export function InfoBar(props: InfoBarProps) {
  const height = () => (props.compact ? '24px' : '28px');

  return (
    <div
      class={props.class}
      title={props.title}
      onClick={(e) => props.onClick?.(e)}
      onDblClick={() => props.onDblClick?.()}
      style={{
        height: height(),
        'min-height': height(),
        display: 'flex',
        'align-items': 'center',
        padding: '0 10px',
        'font-family': "'JetBrains Mono', monospace",
        'font-size': sf(12),
        color: theme.fgMuted,
        'white-space': 'nowrap',
        overflow: props.allowOverflow ? 'visible' : 'hidden',
        'text-overflow': 'ellipsis',
        cursor: props.onClick ? 'pointer' : 'default',
        'user-select': 'none',
        ...props.style,
      }}
    >
      {props.children}
    </div>
  );
}
