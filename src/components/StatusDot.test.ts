import { renderToString } from 'solid-js/web';
import { describe, expect, it } from 'vitest';

import { StatusDot, getDotTooltip } from './StatusDot';

describe('getDotTooltip', () => {
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
});
