import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToString } from 'solid-js/web';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../store/types';

const { mockGetPrChecks } = vi.hoisted(() => ({
  mockGetPrChecks: vi.fn(),
}));

vi.mock('../store/store', () => ({
  store: { editorCommand: null },
  getProject: vi.fn(() => undefined),
  showNotification: vi.fn(),
  getPrChecks: mockGetPrChecks,
  getBranchDivergence: vi.fn(() => null),
}));

vi.mock('../store/github', () => ({ stageFailedChecksPrompt: vi.fn() }));
vi.mock('../lib/platform', () => ({ isMac: false }));
vi.mock('../lib/shell', () => ({
  revealItemInDir: vi.fn(() => Promise.resolve()),
  openInEditor: vi.fn(() => Promise.resolve()),
}));

import { TaskBranchInfoBar } from './TaskBranchInfoBar';
import { getProject } from '../store/store';

const task: Task = {
  id: 'task-1',
  name: 'Review metadata',
  projectId: 'project-1',
  branchName: 'task/review-metadata',
  worktreePath: '/repo/.worktrees/review-metadata',
  agentIds: [],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
  gitIsolation: 'worktree',
  prUrl: 'https://github.com/acme/app/pull/12',
};

describe('TaskBranchInfoBar PR review metadata', () => {
  beforeEach(() => {
    mockGetPrChecks.mockReturnValue({
      overall: 'pending',
      passing: 1,
      pending: 2,
      failing: 0,
      checks: [],
      checkedAt: '2026-08-04T10:00:00.000Z',
      isDraft: false,
      reviewDecision: 'CHANGES_REQUESTED',
    });
  });

  it('shows the short PR label and composes review, CI, and the full URL in its tooltip', () => {
    const html = renderToString(() => TaskBranchInfoBar({ task, onEditProject: vi.fn() }));

    expect(html).toContain('PR #12');
    expect(html).toContain('>Changes<');
    expect(html).toContain(
      'title="Review: changes requested\nCI running — 2 pending, 1 passing\nhttps://github.com/acme/app/pull/12"',
    );
  });

  it.each([
    ['APPROVED', 'Approved', 'approved', 'var(--success)'],
    ['CHANGES_REQUESTED', 'Changes', 'changes-requested', 'var(--warning)'],
    ['REVIEW_REQUIRED', 'Review', 'review-needed', 'var(--accent)'],
  ])(
    'shows the %s decision as compact color-coded %s text with its semantic icon',
    (reviewDecision, label, icon, color) => {
      mockGetPrChecks.mockReturnValue({
        ...mockGetPrChecks(),
        reviewDecision,
      });

      const html = renderToString(() => TaskBranchInfoBar({ task, onEditProject: vi.fn() }));

      expect(html).toContain(`<span class="task-pr-review-label">${label}</span>`);
      expect(html).toContain(`class="task-pr-review-status" style="color:${color}`);
      expect(html).toContain(`task-pr-review-icon--${icon}">`);
      expect(html).not.toContain('background:color-mix');
    },
  );

  it('shows draft with its semantic icon ahead of any review decision', () => {
    mockGetPrChecks.mockReturnValue({
      ...mockGetPrChecks(),
      isDraft: true,
      reviewDecision: 'APPROVED',
    });

    const html = renderToString(() => TaskBranchInfoBar({ task, onEditProject: vi.fn() }));

    expect(html).toContain('<span class="task-pr-review-label">Draft</span>');
    expect(html).toContain('task-pr-review-icon--draft">');
    expect(html).not.toContain('>Approved<');
    expect(html).not.toContain('task-pr-review-icon--approved');
  });

  it('shows a merged PR as a GitHub-purple badge instead of its review state', () => {
    mockGetPrChecks.mockReturnValue({
      overall: 'none',
      merged: true,
      passing: 0,
      pending: 0,
      failing: 0,
      checks: [],
      checkedAt: '2026-08-04T10:00:00.000Z',
    });

    const html = renderToString(() => TaskBranchInfoBar({ task, onEditProject: vi.fn() }));

    expect(html).toContain('<span class="task-pr-review-label">Merged</span>');
    expect(html).toMatch(/class="task-pr-review-status" style="[^"]*background:#8957e5;color:#fff/);
    expect(html).toContain('task-pr-review-icon--merged">');
    expect(html).toContain('aria-label="PR #12, Merged"');
  });

  it('keeps compact review and CI meaning in the PR button accessible label', () => {
    const html = renderToString(() => TaskBranchInfoBar({ task, onEditProject: vi.fn() }));

    expect(html).toContain('aria-label="PR #12, Changes requested, CI running"');
  });

  it('does not render a review placeholder when review metadata is missing', () => {
    mockGetPrChecks.mockReturnValue(undefined);

    const html = renderToString(() => TaskBranchInfoBar({ task, onEditProject: vi.fn() }));

    expect(html).not.toContain('task-pr-review-status');
  });
});

describe('TaskBranchInfoBar GitHub actions', () => {
  it('flags merge conflicts on the PR chip', () => {
    mockGetPrChecks.mockReturnValue({
      overall: 'none',
      passing: 0,
      pending: 0,
      failing: 0,
      checks: [],
      checkedAt: '2026-08-04T10:00:00.000Z',
      mergeable: 'CONFLICTING',
    });

    const html = renderToString(() => TaskBranchInfoBar({ task, onEditProject: vi.fn() }));

    expect(html).toContain('class="task-pr-conflicts"');
    expect(html).toContain('aria-label="PR #12, Conflicts"');
  });

  const checks = (overall: string, extra: Record<string, unknown> = {}) => ({
    overall,
    passing: 1,
    pending: 0,
    failing: overall === 'failure' ? 1 : 0,
    checks: [],
    checkedAt: '2026-08-04T10:00:00.000Z',
    ...extra,
  });

  it('offers a red Fix CI button when the PR checks failed', () => {
    mockGetPrChecks.mockReturnValue(checks('failure'));

    const html = renderToString(() => TaskBranchInfoBar({ task, onEditProject: vi.fn() }));

    expect(html).toMatch(/class="task-pr-fix-ci"[^>]*style="background:var\(--error\)/);
    expect(html).toMatch(/class="task-pr-fix-ci"[^>]*>.*<svg.*Fix CI(<!--\/-->)?<\/button>/);
  });

  it.each([
    ['pending', {}],
    ['success', {}],
    ['failure', { merged: true }],
  ])('does not offer Fix CI when checks are %s %o', (overall, extra) => {
    mockGetPrChecks.mockReturnValue(checks(overall, extra));

    const html = renderToString(() => TaskBranchInfoBar({ task, onEditProject: vi.fn() }));

    expect(html).not.toContain('task-pr-fix-ci');
  });
});

describe('TaskBranchInfoBar source link', () => {
  it('renders a compact issue number without removing the full accessible label', () => {
    const issueTask: Task = {
      ...task,
      githubUrl: 'https://github.com/acme/app/issues/249',
    };

    const html = renderToString(() =>
      TaskBranchInfoBar({ task: issueTask, onEditProject: vi.fn() }),
    );

    expect(html).toContain('class="task-branch-source-compact-label">#249</span>');
    expect(html).toContain('aria-label="Source: acme/app/issues/249"');
  });
});

describe('TaskBranchInfoBar project chip', () => {
  it('renders the full name and its initials so the narrow layout can swap them', () => {
    vi.mocked(getProject).mockReturnValue({
      id: 'project-1',
      name: 'parallel-code',
      path: '/repo',
      color: 'hsl(210, 70%, 75%)',
    } as never);

    const html = renderToString(() => TaskBranchInfoBar({ task, onEditProject: vi.fn() }));

    expect(html).not.toContain('class="project-swatch"');
    expect(html).toContain('border-left:3px solid hsl(210, 70%, 75%)');
    expect(html).toContain('class="task-branch-project-label">parallel-code</span>');
    expect(html).toContain('class="task-branch-project-compact-label"');
    expect(html).toContain('>PC</span>');
    expect(html).toContain('aria-label="Project: parallel-code · Project settings"');
  });
});

describe('TaskBranchInfoBar responsive styles', () => {
  const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');

  it('uses the task bar width as a named inline-size container', () => {
    expect(css).toMatch(
      /\.task-branch-info-bar\s*{[^}]*container-name:\s*task-branch-info[^}]*container-type:\s*inline-size/s,
    );
  });

  it.each([
    { width: 620, className: 'task-branch-path' },
    { width: 620, className: 'task-branch-existing-worktree' },
    { width: 480, className: 'task-branch-project-label' },
    { width: 420, className: 'task-pr-review-label' },
    { width: 340, className: 'task-branch-name' },
    { width: 340, className: 'task-pr-prefix' },
  ])('collapses .$className at $width px', ({ width, className }) => {
    expect(css).toMatch(
      new RegExp(
        `@container\\s+task-branch-info\\s+\\(max-width:\\s*${width}px\\)[\\s\\S]*?\\.${className}\\b[^{]*{[^}]*display:\\s*none`,
      ),
    );
  });

  it('keeps the project visible as initials at 480px', () => {
    expect(css).not.toMatch(
      /@container\s+task-branch-info\s+\(max-width:\s*480px\)[\s\S]*?\.task-branch-project\s*{[^}]*display:\s*none/,
    );
    expect(css).toMatch(
      /@container\s+task-branch-info\s+\(max-width:\s*480px\)[\s\S]*?\.task-branch-project-compact-label\s*{[^}]*display:\s*inline/,
    );
  });

  it('keeps a compact source link visible at 720px', () => {
    expect(css).not.toMatch(
      /@container\s+task-branch-info\s+\(max-width:\s*720px\)[\s\S]*?\.task-branch-source\s*{[^}]*display:\s*none/,
    );
    expect(css).toMatch(
      /@container\s+task-branch-info\s+\(max-width:\s*720px\)[\s\S]*?\.task-branch-source-compact-label\s*{[^}]*display:\s*inline/,
    );
  });

  it('shows the semantic review icon when review text collapses', () => {
    expect(css).toMatch(
      /@container\s+task-branch-info\s+\(max-width:\s*420px\)[\s\S]*?\.task-pr-review-icon\s*{[^}]*display:\s*inline-flex/,
    );
  });

  it('keeps the merged icon visible beside its label at every width', () => {
    expect(css).toMatch(/\.task-pr-review-icon--merged\s*{[^}]*display:\s*inline-flex/);
  });

  it('lets secondary identities ellipsize while keeping PR state non-shrinkable', () => {
    for (const className of ['task-branch-project', 'task-branch-source', 'task-branch-name']) {
      expect(css).toMatch(
        new RegExp(`\\.${className}\\b[^{}]*{[^}]*flex:\\s*0 1 auto[^}]*overflow:\\s*hidden`),
      );
    }
    expect(css).toMatch(/\.task-pr-link\b[^{}]*{[^}]*flex:\s*0 0 auto/);
  });
});
