import { Show } from 'solid-js';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { formatQualityFindingLocation, type QualityFinding } from '../lib/quality-findings';
import { CloseIcon } from './icons';
import { qualityFindingSeverityColor } from './quality-finding-colors';

interface QualityFindingSidebarItemProps {
  finding: QualityFinding;
  selected: boolean;
  onSelected: (selected: boolean) => void;
  onDismiss: () => void;
  onScrollTo: () => void;
}

export function QualityFindingSidebarItem(props: QualityFindingSidebarItemProps) {
  const color = () => qualityFindingSeverityColor(props.finding.severity);
  const isActionable = () => props.finding.freshness === 'current';
  const freshnessLabel = () => {
    if (props.finding.freshness === 'pending') return 'Pending';
    if (props.finding.freshness === 'stale') return 'Stale';
    return null;
  };

  return (
    <div
      onClick={() => {
        if (isActionable()) props.onScrollTo();
      }}
      style={{
        padding: '8px 10px',
        'margin-bottom': '6px',
        'border-left': `3px solid ${isActionable() ? color() : theme.fgSubtle}`,
        'border-radius': '0 4px 4px 0',
        background: 'color-mix(in srgb, var(--fg) 3%, transparent)',
        cursor: isActionable() ? 'pointer' : 'default',
        opacity: isActionable() ? '1' : '0.65',
      }}
    >
      <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
        <input
          type="checkbox"
          checked={props.selected}
          disabled={!isActionable()}
          aria-label={`Select ${props.finding.ruleId} finding`}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => props.onSelected(event.currentTarget.checked)}
        />
        <span
          style={{
            color: isActionable() ? color() : theme.fgMuted,
            'font-size': sf(11),
            'font-weight': '700',
            'text-transform': 'uppercase',
          }}
        >
          Automated · {props.finding.severity} · {props.finding.category}
        </span>
        <span style={{ flex: '1' }} />
        <Show when={freshnessLabel()}>
          {(label) => (
            <span
              style={{
                color: theme.fgMuted,
                'font-size': sf(11),
                'font-weight': '700',
                'text-transform': 'uppercase',
              }}
            >
              {label()}
            </span>
          )}
        </Show>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            props.onDismiss();
          }}
          title="Dismiss finding"
          aria-label={`Dismiss ${props.finding.ruleId} finding`}
          style={{
            display: 'flex',
            background: 'transparent',
            border: 'none',
            color: theme.fgSubtle,
            cursor: 'pointer',
            padding: '2px',
            'border-radius': '2px',
          }}
        >
          <CloseIcon size={12} />
        </button>
      </div>

      <div
        style={{
          'font-size': sf(11),
          color: theme.fgSubtle,
          'font-family': "'JetBrains Mono', monospace",
          overflow: 'hidden',
          'text-overflow': 'ellipsis',
          'white-space': 'nowrap',
          'margin-top': '3px',
        }}
        title={formatQualityFindingLocation(props.finding)}
      >
        {formatQualityFindingLocation(props.finding)}
      </div>

      <div
        style={{
          'font-size': sf(11),
          color: theme.fgMuted,
          'font-family': "'JetBrains Mono', monospace",
          'margin-top': '2px',
        }}
      >
        {props.finding.source}/{props.finding.ruleId}
      </div>

      <div
        style={{
          'font-size': sf(12),
          color: theme.fg,
          'white-space': 'pre-wrap',
          'margin-top': '4px',
        }}
      >
        {props.finding.explanation.length > 180
          ? `${props.finding.explanation.slice(0, 180)}...`
          : props.finding.explanation}
      </div>
    </div>
  );
}
