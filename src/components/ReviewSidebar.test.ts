import { renderToString } from 'solid-js/web';
import { describe, expect, it, vi } from 'vitest';
import type { QualityFinding } from '../lib/quality-findings';
import { ReviewSidebar } from './ReviewSidebar';

function finding(overrides: Partial<QualityFinding> = {}): QualityFinding {
  return {
    id: 'finding-1',
    source: 'fixture',
    ruleId: 'no-floating-promises',
    category: 'reliability',
    severity: 'warning',
    location: { filePath: 'src/app.ts', startLine: 10, startColumn: 3 },
    explanation: 'Await this promise or explicitly handle its rejection.',
    state: 'open',
    freshness: 'current',
    ...overrides,
  };
}

function render(
  findings: QualityFinding[],
  submission: { canSubmit: boolean; submitting: boolean } = {
    canSubmit: true,
    submitting: false,
  },
) {
  return renderToString(() =>
    ReviewSidebar({
      annotations: [
        {
          id: 'human-1',
          filePath: 'src/app.ts',
          startLine: 12,
          endLine: 12,
          selectedText: 'return value;',
          comment: 'Please clarify this return value.',
        },
      ],
      findings,
      selectedFindingIds: new Set(['finding-1']),
      canSubmit: submission.canSubmit,
      submitting: submission.submitting,
      onDismiss: vi.fn(),
      onUpdate: vi.fn(),
      onScrollTo: vi.fn(),
      onSubmit: vi.fn(),
      onFindingSelected: vi.fn(),
      onFindingDismiss: vi.fn(),
      onFindingScrollTo: vi.fn(),
    }),
  );
}

describe('ReviewSidebar', () => {
  it('distinguishes automated findings from human comments with textual metadata', () => {
    const html = render([finding()]);
    const text = html.replace(/<!--.*?-->/g, '');

    expect(text).toContain('Automated findings (1)');
    expect(text).toContain('Automated · warning · reliability');
    expect(text).toContain('fixture/no-floating-promises');
    expect(text).toContain('Human comments (1)');
    expect(text).toContain('Please clarify this return value.');
    expect(text).toContain('Send to agent (2)');
  });

  it('marks stale findings textually and disables their remediation controls', () => {
    const html = render([finding({ freshness: 'stale' })]);

    expect(html).toContain('Stale');
    expect(html).toMatch(
      /<input type="checkbox"[^>]*disabled[^>]*aria-label="Select no-floating-promises finding"/,
    );
  });

  it('marks pending findings textually and disables their remediation controls', () => {
    const html = render([finding({ freshness: 'pending' })]);

    expect(html).toContain('Pending');
    expect(html).toMatch(
      /<input type="checkbox"[^>]*disabled[^>]*aria-label="Select no-floating-promises finding"/,
    );
  });

  it('labels the unified send action as in progress while a submission is active', () => {
    const html = render([finding()], { canSubmit: false, submitting: true });

    expect(html).toContain('title="Sending review..."');
    expect(html).toContain('Sending...');
    expect(html).not.toContain('No agent available');
  });
});
