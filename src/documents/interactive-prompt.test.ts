import { describe, expect, it } from 'vitest';
import { buildInteractivePrompt } from './interactive-prompt';

describe('buildInteractivePrompt', () => {
  it('puts the instruction first, then the document, the lines and the passage', () => {
    const prompt = buildInteractivePrompt(
      'notes.md',
      {
        startBlock: 1,
        endBlock: 1,
        startLine: 4,
        endLine: 6,
        quote: 'One.\nTwo.',
        heading: 'Plan',
        wholeDocument: false,
      },
      '  Tighten this.  ',
    );
    expect(prompt).toBe(
      'Tighten this.\n\nDocument: notes.md\n\nScope: lines 4-6 (under "Plan").\n\n' +
        'The passage, verbatim:\n> One.\n> Two.',
    );
  });

  it('leaves out the quote for the whole document', () => {
    const prompt = buildInteractivePrompt(
      'notes.md',
      {
        startBlock: 0,
        endBlock: 3,
        startLine: 1,
        endLine: 40,
        quote: '',
        wholeDocument: true,
      },
      'Rewrite the intro.',
    );
    expect(prompt).toBe('Rewrite the intro.\n\nDocument: notes.md\n\nScope: the whole document.');
  });

  it('drops the control characters a pasted passage would turn into keystrokes', () => {
    const prompt = buildInteractivePrompt(
      'notes.md',
      {
        startBlock: 0,
        endBlock: 0,
        startLine: 1,
        endLine: 1,
        quote: 'Harmless\u001b[201~ then \r/yes',
        heading: undefined,
        wholeDocument: false,
      },
      'Rewrite it.',
    );
    expect(prompt).toContain('> Harmless[201~ then /yes');
    expect(prompt).not.toContain('\u001b');
    expect(prompt).not.toContain('\r');
  });
});
