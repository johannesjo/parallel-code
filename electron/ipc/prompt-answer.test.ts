import { describe, expect, it, vi } from 'vitest';
import { answerAgentPrompt, peekAgentPrompt } from './prompt-answer.js';

const DIALOG = [
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for npm test commands",
  '   3. No, and tell Claude what to do differently (esc)',
  '',
  '',
].join('\n');
const SEEN = {
  body: ['Do you want to proceed?'],
  labels: [
    'Yes',
    "Yes, and don't ask again for npm test commands",
    'No, and tell Claude what to do differently',
  ],
};

describe('answerAgentPrompt', () => {
  it("types the option's key when the same dialog is still on screen", () => {
    const write = vi.fn();
    expect(answerAgentPrompt({ screen: () => DIALOG, write, n: 2, seen: SEEN })).toBe(true);
    expect(write).toHaveBeenCalledWith('2');
  });

  it('presses Esc for an option whose hint is (esc)', () => {
    const write = vi.fn();
    answerAgentPrompt({ screen: () => DIALOG, write, n: 3, seen: SEEN });
    expect(write).toHaveBeenCalledWith('\x1b');
  });

  it.each([
    ['the dialog is gone', '⏺ Done\n❯ '],
    ['another dialog replaced it', ' Edit file?\n ❯ 1. Yes\n   2. No'],
    ['the mirror has no screen yet', null],
    [
      "another command's dialog with the same choices replaced it",
      DIALOG.replace(' Do you want to proceed?', ' rm -rf dist\n Do you want to proceed?'),
    ],
  ])('types nothing when %s', (_case, screen) => {
    const write = vi.fn();
    expect(answerAgentPrompt({ screen: () => screen, write, n: 1, seen: SEEN })).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('types nothing for an option number the dialog lacks', () => {
    const write = vi.fn();
    expect(answerAgentPrompt({ screen: () => DIALOG, write, n: 4, seen: SEEN })).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('peekAgentPrompt', () => {
  it('returns the dialog and the last non-blank rows', () => {
    const peek = peekAgentPrompt(() => DIALOG);
    expect(peek?.menu?.options.map((o) => o.n)).toEqual([1, 2, 3]);
    expect(peek?.tail[peek.tail.length - 1]).toBe(
      '   3. No, and tell Claude what to do differently (esc)',
    );
  });

  it('has no dialog for a plain prompt, only the rows', () => {
    expect(peekAgentPrompt(() => 'Overwrite file? [y/N]\n')).toEqual({
      menu: null,
      tail: ['Overwrite file? [y/N]'],
    });
  });
});
