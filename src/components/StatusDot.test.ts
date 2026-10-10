import { renderToString } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';

import { removePrChecks, setPrChecks } from '../store/pr-checks-state';
import { theme } from '../lib/theme';
import { StatusDot, getDotTooltip, getStatusGlyph } from './StatusDot';

function prChecks(overall: 'pending' | 'success' | 'failure' | 'none') {
  return { overall, passing: 0, pending: 0, failing: 0, checks: [], checkedAt: '' };
}

describe('getDotTooltip', () => {
  afterEach(() => removePrChecks('t1'));

  it('describes review status', () => {
    expect(getDotTooltip('review')).toBe('Ready for review');
  });

  it('describes busy status', () => {
    expect(getDotTooltip('busy')).toBe('Busy — agent recently active');
  });

  it('uses attention state before dot status', () => {
    expect(getDotTooltip('ready', 'needs_input')).toBe('Waiting for input');
  });

  // A review-flagged task whose agent is still active is dot status 'busy' with
  // attention 'review' — the purple dot must not read "Busy".
  it('describes review attention over a busy dot status', () => {
    expect(getDotTooltip('busy', 'review')).toBe('Ready for review');
  });

  // `ready` only means no known failure, so pending CI must not claim mergeability.
  it('names the ready state after the PR checks', () => {
    expect(getDotTooltip('ready', 'ready', 't1')).toBe('Ready');
    setPrChecks('t1', prChecks('pending'));
    expect(getDotTooltip('ready', 'ready', 't1')).toBe('CI running');
    setPrChecks('t1', prChecks('success'));
    expect(getDotTooltip('ready', 'ready', 't1')).toBe('Ready to merge');
  });
});

describe('StatusDot', () => {
  it('attaches the tooltip to the dot element', () => {
    const html = renderToString(() => StatusDot({ status: 'review' }));

    expect(html).toContain('title="Ready for review"');
  });

  it('uses attention state for the rendered tooltip', () => {
    const html = renderToString(() => StatusDot({ status: 'ready', attention: 'needs_input' }));

    expect(html).toContain('title="Waiting for input"');
  });

  it('adds activity provenance separately from the aggregate task status', () => {
    const html = renderToString(() => StatusDot({ status: 'review', taskId: 'missing' }));
    expect(html).toContain('Ready for review\nActivity evidence unavailable');
  });
});

describe('status glyph shapes', () => {
  it('spins while an agent is working and asks with a question mark when blocked', () => {
    expect(renderToString(() => StatusDot({ status: 'busy', attention: 'active' }))).toContain(
      'status-glyph-spinner',
    );
    const asking = renderToString(() => StatusDot({ status: 'busy', attention: 'needs_input' }));
    expect(asking).toContain('status-glyph-question');
    expect(asking).not.toContain('status-glyph-spinner');
  });

  it('rests as a plain dot when idle, errored, or under review', () => {
    for (const attention of ['idle', 'error', 'review', 'ready'] as const) {
      const html = renderToString(() => StatusDot({ status: 'busy', attention }));
      expect(html, attention).not.toContain('status-glyph-spinner');
      expect(html, attention).not.toContain('status-glyph-question');
    }
  });
});

describe('CI glyphs', () => {
  afterEach(() => removePrChecks('t1'));

  function checks(overall: 'pending' | 'failure', counts: Partial<Record<string, number>> = {}) {
    return { ...prChecks(overall), passing: 3, pending: 1, failing: 0, ...counts };
  }

  it('shows a progress pie while CI runs and a cross when it fails', () => {
    setPrChecks('t1', checks('pending'));
    const running = renderToString(() => StatusDot({ status: 'ready', taskId: 't1' }));
    expect(running).toContain('status-glyph-ci');
    expect(running).toContain('--ci-sweep:75%');
    expect(running).toContain('title="CI running — 3 of 4 checks done');

    setPrChecks('t1', checks('failure', { pending: 0, failing: 2 }));
    const failed = renderToString(() => StatusDot({ status: 'ready', taskId: 't1' }));
    expect(failed).toContain('×');
    expect(failed).toContain('title="CI failed — 2 of 5 checks failing');
  });

  it('yields to a working, blocked, or errored agent', () => {
    expect(getStatusGlyph('busy', 'active', 'failed')).toBe('spinner');
    expect(getStatusGlyph('busy', 'needs_input', 'failed')).toBe('question');
    expect(getStatusGlyph('busy', 'error', 'running')).toBe('dot');
    expect(getStatusGlyph('busy', 'shell_busy', 'running')).toBe('ci_running');
    expect(getStatusGlyph('review', 'review', 'failed')).toBe('ci_failed');
  });

  it('turns the pie red once a check fails mid-run', () => {
    setPrChecks('t1', checks('pending', { failing: 1 }));
    const html = renderToString(() => StatusDot({ status: 'ready', taskId: 't1' }));
    expect(html).toContain(`color:${theme.error}`);
    expect(html).toContain('4 of 5 checks done, 1 failing');
  });

  it('keeps the agent tooltip when the agent glyph wins', () => {
    setPrChecks('t1', checks('failure', { pending: 0, failing: 1 }));
    expect(getDotTooltip('busy', 'active', 't1')).toBe('Active — agent is working');
    expect(getDotTooltip('busy', 'needs_input', 't1')).toBe('Waiting for input');
  });

  it('ignores merged PRs and passing or absent CI', () => {
    for (const next of [
      { ...checks('failure', { failing: 1 }), merged: true },
      { ...checks('pending'), merged: true },
      prChecks('success'),
      prChecks('none'),
    ]) {
      setPrChecks('t1', next);
      const html = renderToString(() => StatusDot({ status: 'ready', taskId: 't1' }));
      expect(html, next.overall).not.toContain('×');
      expect(html, next.overall).not.toContain('status-glyph-ci');
    }
  });
});
