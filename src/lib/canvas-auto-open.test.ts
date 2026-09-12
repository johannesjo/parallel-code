import { describe, expect, it } from 'vitest';
import { isPlanApprovalEvent, nextCanvasOpen, worktreeMarkdownPath } from './canvas-auto-open';

const wt = '/home/u/proj/.worktrees/task-a';

describe('worktreeMarkdownPath', () => {
  it('accepts absolute paths inside the worktree and relative ones', () => {
    expect(worktreeMarkdownPath(`${wt}/docs/plan.md`, wt)).toBe('docs/plan.md');
    expect(worktreeMarkdownPath('./NOTES.markdown', `${wt}/`)).toBe('NOTES.markdown');
  });

  it('rejects files outside the worktree, non-Markdown, traversal and app folders', () => {
    expect(worktreeMarkdownPath('/home/u/proj/README.md', wt)).toBeNull();
    expect(worktreeMarkdownPath(`${wt}/src/a.ts`, wt)).toBeNull();
    expect(worktreeMarkdownPath('../x.md', wt)).toBeNull();
    expect(worktreeMarkdownPath('.claude/plans/p.md', wt)).toBeNull();
    expect(worktreeMarkdownPath(`${wt}/docs/very-long-name…`, wt)).toBeNull();
  });
});

describe('nextCanvasOpen', () => {
  const pre = (toolUseId: string, detail: string, toolName = 'Write') => ({
    event: 'PreToolUse',
    toolName,
    toolUseId,
    detail,
  });

  it('opens the file once the write the pre-hook announced completes', () => {
    const pending = new Map<string, string>();
    expect(nextCanvasOpen(pending, pre('t1', 'docs/a.md'), wt)).toBeNull();
    expect(nextCanvasOpen(pending, { event: 'PostToolUse', toolUseId: 't1' }, wt)).toBe(
      'docs/a.md',
    );
    expect(pending.size).toBe(0);
  });

  it('ignores reads, other files, failures and unknown ids', () => {
    const pending = new Map<string, string>();
    nextCanvasOpen(pending, pre('r', 'a.md', 'Read'), wt);
    nextCanvasOpen(pending, pre('e', 'a.ts', 'Edit'), wt);
    expect(pending.size).toBe(0);
    nextCanvasOpen(pending, pre('f', 'b.md', 'Edit'), wt);
    expect(nextCanvasOpen(pending, { event: 'PostToolUseFailure', toolUseId: 'f' }, wt)).toBeNull();
    expect(nextCanvasOpen(pending, { event: 'PostToolUse', toolUseId: 'f' }, wt)).toBeNull();
    expect(nextCanvasOpen(pending, { event: 'PostToolUse', toolUseId: 'zz' }, wt)).toBeNull();
  });

  it('drops the oldest pending write when the map is full', () => {
    const pending = new Map<string, string>();
    for (let i = 0; i < 51; i++) nextCanvasOpen(pending, pre(`t${i}`, `${i}.md`), wt);
    expect(pending.size).toBe(50);
    expect(pending.has('t0')).toBe(false);
  });
});

describe('isPlanApprovalEvent', () => {
  it('is the pre-hook of ExitPlanMode, however the vendor spells it', () => {
    expect(isPlanApprovalEvent({ event: 'PreToolUse', toolName: 'ExitPlanMode' })).toBe(true);
    expect(isPlanApprovalEvent({ event: 'PreToolUse', toolName: 'exit_plan_mode' })).toBe(true);
    expect(isPlanApprovalEvent({ event: 'PostToolUse', toolName: 'ExitPlanMode' })).toBe(false);
    expect(isPlanApprovalEvent({ event: 'PreToolUse', toolName: 'Write' })).toBe(false);
  });
});
