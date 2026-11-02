import { describe, it, expect } from 'vitest';
import { messageForTerminal, terminalBufferText } from './terminalText';

describe('composed phone replies', () => {
  it('preserves multiline text within bracketed paste', () => {
    expect(messageForTerminal('first\r\nsecond', true)).toBe('\x1b[200~first\nsecond\x1b[201~');
  });
  it('does not accidentally submit each line in terminals without paste support', () => {
    expect(messageForTerminal('first\nsecond', false)).toBe('first second');
  });
  it('removes pasted control characters and refuses an empty message', () => {
    expect(messageForTerminal('\x03hello\x1b', true)).toBe('\x1b[200~hello\x1b[201~');
    expect(messageForTerminal(' \n\x03 ', true)).toBe('');
  });
});

describe('selectable terminal text', () => {
  const buffer = (lines: [string, boolean][]) => ({
    length: lines.length,
    getLine: (i: number) => {
      const line = lines[i];
      return line && { isWrapped: line[1], translateToString: () => line[0] };
    },
  });
  it('joins soft-wrapped rows and drops trailing blank rows', () => {
    expect(
      terminalBufferText(
        buffer([
          ['first half ', false],
          ['second half', true],
          ['next line', false],
          ['', false],
          ['', false],
        ]),
      ),
    ).toBe('first half second half\nnext line');
  });
});
