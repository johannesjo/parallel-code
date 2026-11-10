import { describe, expect, it } from 'vitest';
import { processAutoFireTick } from './autofire-tick';
import type { StagedNotification } from '../store/types';

const staged: StagedNotification = {
  batchId: 'batch-1',
  notificationIds: ['n1'],
  text: 'hello coordinator',
  autoFireAt: 1_000,
  userEdited: false,
};

const pastNow = 2_000; // past autoFireAt=1000
const futureNow = 500; // before autoFireAt=1000
const noPromptTail = 'agent is thinking...';
const promptTail = 'agent output ❯ ';

const stagedEdited: StagedNotification = {
  ...staged,
  userEdited: true,
};

describe('processAutoFireTick — userEdited suppression', () => {
  it('returns paused when userEdited=true with controlledBy coordinator and prompt visible', () => {
    const result = processAutoFireTick({
      staged: stagedEdited,
      now: pastNow,
      controlledBy: 'coordinator',
      questionActive: false,
      tail: promptTail,
      currentMissCount: 0,
    });
    expect(result.outcome).toBe('paused');
  });

  it('returns paused when userEdited=true with controlledBy undefined and prompt visible', () => {
    const result = processAutoFireTick({
      staged: stagedEdited,
      now: pastNow,
      controlledBy: undefined,
      questionActive: false,
      tail: promptTail,
      currentMissCount: 0,
    });
    expect(result.outcome).toBe('paused');
  });

  it('returns paused when userEdited=true with controlledBy human', () => {
    const result = processAutoFireTick({
      staged: stagedEdited,
      now: pastNow,
      controlledBy: 'human',
      questionActive: false,
      tail: promptTail,
      currentMissCount: 0,
    });
    expect(result.outcome).toBe('paused');
  });

  it('fires when userEdited=false with controlledBy coordinator and prompt visible (regression guard)', () => {
    const result = processAutoFireTick({
      staged,
      now: pastNow,
      controlledBy: 'coordinator',
      questionActive: false,
      tail: promptTail,
      currentMissCount: 0,
    });
    expect(result.outcome).toBe('fire');
  });
});

describe('processAutoFireTick — user activity blockers', () => {
  it('does not pause solely because controlledBy is human', () => {
    const result = processAutoFireTick({
      staged,
      now: pastNow,
      controlledBy: 'human',
      questionActive: false,
      tail: noPromptTail,
      currentMissCount: 0,
    });
    expect(result).toEqual({ outcome: 'no-prompt', newMissCount: 1 });
  });

  it('fires with a prompt marker even when controlledBy is human', () => {
    const result = processAutoFireTick({
      staged,
      now: pastNow,
      controlledBy: 'human',
      questionActive: false,
      tail: promptTail,
      currentMissCount: 0,
    });
    expect(result.outcome).toBe('fire');
  });

  it('waits while the user has a prompt draft', () => {
    const result = processAutoFireTick({
      staged,
      now: pastNow,
      controlledBy: 'coordinator',
      promptDraftActive: true,
      questionActive: false,
      tail: promptTail,
      currentMissCount: 0,
    });
    expect(result.outcome).toBe('waiting');
  });

  it('waits while terminal input may be pending', () => {
    const result = processAutoFireTick({
      staged,
      now: pastNow,
      controlledBy: 'coordinator',
      terminalInputPending: true,
      questionActive: false,
      tail: promptTail,
      currentMissCount: 0,
    });
    expect(result.outcome).toBe('waiting');
  });

  it('waits while a recent user activity lease is active', () => {
    const result = processAutoFireTick({
      staged,
      now: pastNow,
      controlledBy: 'coordinator',
      userActivityHoldUntil: pastNow + 1_000,
      questionActive: false,
      tail: promptTail,
      currentMissCount: 0,
    });
    expect(result.outcome).toBe('waiting');
  });
});

describe('processAutoFireTick — questionActive suppresses autofire', () => {
  it('returns paused when questionActive is true, even with a ❯ in the tail', () => {
    const result = processAutoFireTick({
      staged,
      now: pastNow,
      controlledBy: 'coordinator',
      questionActive: true,
      tail: promptTail,
      currentMissCount: 0,
    });
    expect(result.outcome).toBe('paused');
  });

  it('fires normally when questionActive is false and ❯ is visible', () => {
    const result = processAutoFireTick({
      staged,
      now: pastNow,
      controlledBy: 'coordinator',
      questionActive: false,
      tail: promptTail,
      currentMissCount: 0,
    });
    expect(result.outcome).toBe('fire');
  });
});

describe('processAutoFireTick — dialog-like tails (item 2: initial prompt never fires into dialogs)', () => {
  it('waits when tail contains [Y/n] but no ❯ marker', () => {
    const result = processAutoFireTick({
      staged,
      now: pastNow,
      controlledBy: 'coordinator',
      questionActive: false,
      tail: 'Do you want to proceed? [Y/n]',
      currentMissCount: 0,
    });
    expect(result.outcome).toBe('too-soon');
  });

  it('returns fire when tail has ❯ even if it appears in a dialog — caller must check questionActive', () => {
    // processAutoFireTick itself cannot distinguish dialog ❯ from agent prompt ❯.
    // Protection against firing into dialogs is enforced at the PromptInput call site
    // via the questionActive() guard (lines ~604 of PromptInput.tsx).
    const result = processAutoFireTick({
      staged,
      now: pastNow,
      controlledBy: 'coordinator',
      questionActive: false,
      tail: '  ❯ Yes\n    No',
      currentMissCount: 0,
    });
    expect(result.outcome).toBe('fire');
  });

  it('waits for a Claude trust dialog lacking the prompt marker', () => {
    const result = processAutoFireTick({
      staged,
      now: pastNow,
      controlledBy: 'coordinator',
      questionActive: false,
      tail: 'Do you trust the files in this folder? (y/n)',
      currentMissCount: 0,
    });
    expect(result.outcome).toBe('too-soon');
  });
});

describe('processAutoFireTick — coordinator respects autoFireAt and promptless grace', () => {
  it('waits for autoFireAt when coordinator is in control even if ❯ is visible', () => {
    const result = processAutoFireTick({
      staged,
      now: futureNow,
      controlledBy: 'coordinator',
      questionActive: false,
      tail: promptTail,
      currentMissCount: 0,
    });
    expect(result.outcome).toBe('too-soon');
  });

  it('waits for autoFireAt when coordinator is in control and ❯ is absent', () => {
    const result = processAutoFireTick({
      staged,
      now: futureNow,
      controlledBy: 'coordinator',
      questionActive: false,
      tail: noPromptTail,
      currentMissCount: 0,
    });
    expect(result.outcome).toBe('too-soon');
  });

  it('fires without ❯ when coordinator is in control and autoFireAt passed by 2+ minutes', () => {
    const result = processAutoFireTick({
      staged,
      now: staged.autoFireAt + 120_001,
      controlledBy: 'coordinator',
      questionActive: false,
      tail: noPromptTail,
      currentMissCount: 0,
    });
    expect(result.outcome).toBe('fire');
  });

  it('keeps waiting without incrementing misses when coordinator has no ❯ and grace has not elapsed', () => {
    const result = processAutoFireTick({
      staged,
      now: staged.autoFireAt + 60_000,
      controlledBy: 'coordinator',
      questionActive: false,
      tail: noPromptTail,
      currentMissCount: 0,
    });
    expect(result.outcome).toBe('too-soon');
  });

  it('still returns too-soon when controlledBy is undefined and autoFireAt is in the future', () => {
    const result = processAutoFireTick({
      staged,
      now: futureNow,
      controlledBy: undefined,
      questionActive: false,
      tail: promptTail,
      currentMissCount: 0,
    });
    expect(result.outcome).toBe('too-soon');
  });
});

describe('processAutoFireTick — controlledBy reverts to coordinator', () => {
  it('does not increment the miss counter when coordinator has no prompt before grace elapses', () => {
    const result = processAutoFireTick({
      staged,
      now: futureNow,
      controlledBy: 'coordinator',
      questionActive: false,
      tail: noPromptTail,
      currentMissCount: 0,
    });
    expect(result.outcome).toBe('too-soon');
    expect('newMissCount' in result).toBe(false);
  });

  it('keeps the miss counter unchanged when control returns before grace elapses', () => {
    // Simulate: misses accumulated to 3, then human paused (counter stayed at 3),
    // then coordinator took back over — waiting should not count as another miss.
    const result = processAutoFireTick({
      staged,
      now: futureNow,
      controlledBy: 'coordinator',
      questionActive: false,
      tail: noPromptTail,
      currentMissCount: 3,
    });
    expect(result.outcome).toBe('too-soon');
    expect('newMissCount' in result).toBe(false);
  });

  it('fires when the prompt marker is visible after control returns to coordinator', () => {
    const result = processAutoFireTick({
      staged,
      now: pastNow,
      controlledBy: 'coordinator',
      questionActive: false,
      tail: promptTail,
      currentMissCount: 2,
    });
    expect(result.outcome).toBe('fire');
  });

  it('also fires when controlledBy is undefined (unset coordinator task)', () => {
    const result = processAutoFireTick({
      staged,
      now: pastNow,
      controlledBy: undefined,
      questionActive: false,
      tail: promptTail,
      currentMissCount: 0,
    });
    expect(result.outcome).toBe('fire');
  });
});

describe('processAutoFireTick — selection menu', () => {
  it('holds while a numbered menu is up, even past the coordinator grace period', () => {
    const result = processAutoFireTick({
      staged,
      now: staged.autoFireAt + 600_000,
      controlledBy: 'coordinator',
      questionActive: false,
      menuBlocking: true,
      tail: promptTail,
      currentMissCount: 0,
    });
    expect(result.outcome).toBe('paused');
  });
});
