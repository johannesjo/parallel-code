import { describe, expect, it } from 'vitest';
import { terminalOutputPrompt } from './terminal-output-prompt';

describe('terminalOutputPrompt', () => {
  it('fences the output under a heading', () => {
    expect(terminalOutputPrompt('$ npm test\n2 failed')).toBe(
      'Terminal output:\n```\n$ npm test\n2 failed\n```',
    );
  });

  it('uses a longer fence than any backtick run in the output', () => {
    expect(terminalOutputPrompt('a ```js b ```` c')).toBe(
      'Terminal output:\n`````\na ```js b ```` c\n`````',
    );
  });
});
