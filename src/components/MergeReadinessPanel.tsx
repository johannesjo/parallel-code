import { For, Show } from 'solid-js';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import type { MergeReadinessCheck, MergeReadinessCheckStatus } from './merge-readiness';

function checkHelp(label: string): string | undefined {
  if (label === 'Merge safety') {
    return 'Checks the task branch for conflicts with its base branch, branch mismatch, committed changes, and local uncommitted changes.';
  }
  if (label === 'Verify command') {
    return "Runs the project's verify command in the task worktree when you click Run or build evidence, when land_self is called, or when the coordinator merges. Agents and the coordinator must pass it to land; for your own merge it is advisory. The result is pinned to the commit it ran at; opening the dialog never runs commands.";
  }
  if (label === 'Agent report') {
    return 'What the agent reported when it called land_self. Set a verify command in the project settings so the app runs the check itself.';
  }
  if (label === 'Evidence') {
    return 'Confidence of the evidence package for this commit: checks, test changes and flags. Advisory; it never blocks a merge.';
  }
  if (label === 'PR checks') {
    return 'Uses checks reported for a detected GitHub pull request. Pull requests are optional, and unavailable check data is neutral.';
  }
  if (label === 'Coverage') {
    return 'Compares existing task and base-branch coverage reports. Opening the dialog never runs tests or modifies either worktree.';
  }
  return undefined;
}

function statusColor(status: MergeReadinessCheckStatus): string {
  if (status === 'pass') return theme.success;
  if (status === 'blocked') return theme.error;
  if (status === 'warning' || status === 'checking') return theme.warning;
  return theme.fgMuted;
}

function statusSymbol(status: MergeReadinessCheckStatus): string {
  if (status === 'pass') return '✓';
  if (status === 'blocked') return '×';
  if (status === 'warning') return '!';
  if (status === 'checking') return '…';
  return '—';
}

/** Spoken in place of the hidden symbol, so status never rests on glyph or colour. */
const STATUS_WORD: Record<MergeReadinessCheckStatus, string> = {
  pass: 'Passed',
  warning: 'Warning',
  blocked: 'Blocked',
  checking: 'Checking',
  neutral: 'No data',
};

/** Passing and informational rows need no reading; they share one line each. */
function isQuiet(status: MergeReadinessCheckStatus): boolean {
  return status === 'pass' || status === 'neutral';
}

/** One line naming every check of a quiet status; the details are on hover. */
function QuietLine(props: { checks: MergeReadinessCheck[]; status: 'pass' | 'neutral' }) {
  const checks = () => props.checks.filter((check) => check.status === props.status);
  return (
    <Show when={checks().length > 0}>
      <div style={{ 'font-size': sf(12), color: statusColor(props.status) }}>
        <span aria-hidden="true" style={{ display: 'inline-block', width: '16px' }}>
          {statusSymbol(props.status)}
        </span>
        <span class="dialog-sr-only">{STATUS_WORD[props.status]}: </span>
        <For each={checks()}>
          {(check, index) => (
            <>
              {index() > 0 ? ' · ' : ''}
              <span
                title={`${check.detail}${checkHelp(check.label) ? `\n\n${checkHelp(check.label)}` : ''}`}
              >
                {check.label}
                {/* The hover title is out of reach without a pointer. */}
                <span class="dialog-sr-only"> ({check.detail})</span>
              </span>
            </>
          )}
        </For>
      </div>
    </Show>
  );
}

/**
 * The readiness signals no other part of the dialog shows. Always open: a fold
 * that tracked the status closed itself mid-run and hid what was being watched.
 * Rows that need a look get a line each; the rest share one to save height.
 */
export function MergeReadinessPanel(props: { checks: MergeReadinessCheck[] }) {
  return (
    <div aria-label="Merge readiness" role="group" style={{ display: 'grid', gap: '5px' }}>
      <For each={props.checks.filter((check) => !isQuiet(check.status))}>
        {(check) => (
          <div
            style={{
              display: 'grid',
              'grid-template-columns': '116px minmax(0, 1fr)',
              gap: '8px',
              'align-items': 'baseline',
              'font-size': sf(12),
            }}
          >
            <span
              title={checkHelp(check.label)}
              style={{ color: statusColor(check.status), 'font-weight': '600' }}
            >
              <span aria-hidden="true" style={{ display: 'inline-block', width: '16px' }}>
                {statusSymbol(check.status)}
              </span>
              <span class="dialog-sr-only">{STATUS_WORD[check.status]}: </span>
              {check.label}
            </span>
            <span style={{ color: theme.fgMuted }}>{check.detail}</span>
          </div>
        )}
      </For>
      <QuietLine checks={props.checks} status="pass" />
      <QuietLine checks={props.checks} status="neutral" />
    </div>
  );
}
