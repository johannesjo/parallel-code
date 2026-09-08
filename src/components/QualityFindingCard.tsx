import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { formatQualityFindingLocation, type QualityFinding } from '../lib/quality-findings';
import { CloseIcon } from './icons';
import { qualityFindingSeverityColor } from './quality-finding-colors';

interface QualityFindingCardProps {
  finding: QualityFinding;
  onDismiss: () => void;
}

export function QualityFindingCard(props: QualityFindingCardProps) {
  const color = () => qualityFindingSeverityColor(props.finding.severity);

  return (
    <div
      style={{
        margin: '4px 40px 4px 80px',
        'max-width': '560px',
        'border-left': `3px solid ${color()}`,
        'border-radius': '0 4px 4px 0',
        background: `color-mix(in srgb, ${theme.bgElevated} 90%, ${color()} 10%)`,
        padding: '8px 12px',
        'font-family': "'JetBrains Mono', monospace",
      }}
    >
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '6px',
          'font-size': sf(11),
          color: color(),
          'font-weight': '600',
          'text-transform': 'uppercase',
        }}
      >
        <span>Automated</span>
        <span aria-hidden="true">·</span>
        <span>{props.finding.severity}</span>
        <span aria-hidden="true">·</span>
        <span>{props.finding.category}</span>
        <span style={{ flex: '1' }} />
        <button
          type="button"
          onClick={() => props.onDismiss()}
          title="Dismiss finding"
          aria-label="Dismiss finding"
          style={{
            display: 'flex',
            background: 'transparent',
            border: 'none',
            color: theme.fgMuted,
            cursor: 'pointer',
            padding: '2px',
            'border-radius': 'var(--radius-xs)',
          }}
        >
          <CloseIcon size={13} />
        </button>
      </div>

      <div
        style={{
          'margin-top': '3px',
          color: theme.fgSubtle,
          'font-size': sf(11),
          display: 'flex',
          gap: '6px',
          'flex-wrap': 'wrap',
        }}
      >
        <span>{props.finding.source}</span>
        <span aria-hidden="true">/</span>
        <span>{props.finding.ruleId}</span>
        <span aria-hidden="true">·</span>
        <span>{formatQualityFindingLocation(props.finding)}</span>
      </div>

      <div
        style={{
          color: theme.fg,
          'font-size': sf(13),
          'white-space': 'pre-wrap',
          'margin-top': '5px',
        }}
      >
        {props.finding.explanation}
      </div>
    </div>
  );
}
