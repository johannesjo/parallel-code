import { describe, expect, it } from 'vitest';
import { remoteChatPreview, remoteOutputPreview } from './remoteStatusSync';

const resetNotice = 'You have 1 usage limit reset available. Run /usage to use one.';

describe('remote task output previews', () => {
  it.each([
    'Ask codex to do anything',
    '› Ask Codex to do anything',
    '❯ Ask Codex to do anything…',
    '│ › Ask Codex to do anything │',
    '\x1b[2m› Ask Codex to do anything\x1b[0m',
  ])('skips the Codex input placeholder: %s', (placeholder) => {
    expect(
      remoteOutputPreview(`Fixed the failing test\n${placeholder}\n${resetNotice}\nq q q`),
    ).toBe('Fixed the failing test');
    expect(remoteOutputPreview(`${placeholder}\n${resetNotice}\nq q q`)).toBe('');
  });

  it('keeps real output that discusses the placeholder', () => {
    const output = 'Removed the "Ask Codex to do anything" placeholder from task previews.';
    expect(remoteOutputPreview(output)).toBe(output);
  });

  it('uses the last useful line before the Codex usage-reset banner and drawing artifacts', () => {
    expect(
      remoteOutputPreview(`Inspecting the change\nTests passed\n${resetNotice} q q q q q q`),
    ).toBe('Tests passed');
  });

  it('handles wrapped reset notices and separate drawing lines', () => {
    expect(
      remoteOutputPreview(
        'Updated the mobile layout\nYou have 2 usage limit resets\navailable. Run /usage to use\none.\nq\nq q q\n›',
      ),
    ).toBe('Updated the mobile layout');
  });

  it('preserves row boundaries in cursor-positioned redraws and ignores DEC borders', () => {
    expect(
      remoteOutputPreview(
        `\x1b[10;1HReady for review\x1b[11;1H${resetNotice}\x1b[12;1H\x1b(0qqqqqq\x1b(B\n›\ngpt-5.4 high · ~/repo`,
      ),
    ).toBe('Ready for review');
  });

  it('does not mistake a real usage-limit error or an agent question for the reset notice', () => {
    expect(remoteOutputPreview("You've hit your usage limit. Try again later.")).toBe(
      "You've hit your usage limit. Try again later.",
    );
    expect(remoteOutputPreview('Continue with the migration? [y/N]')).toBe(
      'Continue with the migration? [y/N]',
    );
    expect(remoteOutputPreview('Press q to quit')).toBe('Press q to quit');
  });

  it('keeps ordinary output and strips color escapes', () => {
    expect(remoteOutputPreview('Starting\r\n\x1b[32mAll tests passed\x1b[0m\n\n')).toBe(
      'All tests passed',
    );
    expect(remoteOutputPreview('x'.repeat(400))).toHaveLength(300);
    expect(remoteOutputPreview(`Tests passed\r${resetNotice}\rq q q`)).toBe('Tests passed');
  });

  it('leaves the preview empty when only terminal chrome is available', () => {
    expect(remoteOutputPreview(`${resetNotice}\nq q q\n›`)).toBe('');
    expect(remoteOutputPreview('')).toBe('');
  });
});

describe('remote chat previews', () => {
  it('shows the last line of the latest reply', () => {
    expect(
      remoteChatPreview({
        status: 'working',
        requests: [],
        items: [
          { id: '1', kind: 'assistant', text: 'Looking.\n\nFixed the test.\n' },
          { id: '2', kind: 'tool', text: 'npm test' },
          { id: '3', kind: 'assistant', text: '  ' },
        ],
      }),
    ).toBe('Fixed the test.');
  });
  it('is empty before the agent replies', () => {
    expect(remoteChatPreview(undefined)).toBe('');
    expect(
      remoteChatPreview({
        status: 'ready',
        requests: [],
        items: [{ id: '1', kind: 'user', text: 'Hi' }],
      }),
    ).toBe('');
  });
});
