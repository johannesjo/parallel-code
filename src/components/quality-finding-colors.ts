import { theme } from '../lib/theme';
import type { QualityFindingSeverity } from '../lib/quality-findings';

export function qualityFindingSeverityColor(severity: QualityFindingSeverity): string {
  if (severity === 'error') return theme.error;
  if (severity === 'warning') return theme.warning;
  return theme.accent;
}
