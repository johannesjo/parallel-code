import headless from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { leaveCursorQueriesToMain } from './terminalQueries';

// The headless build shares xterm's parser, so it stands in for the renderer's xterm.
async function repliesTo(query: string): Promise<string[]> {
  const term = new headless.Terminal({ cols: 80, rows: 24 });
  leaveCursorQueriesToMain(term);
  const replies: string[] = [];
  term.onData((data) => replies.push(data));
  await new Promise<void>((resolve) => term.write(query, resolve));
  term.dispose();
  return replies;
}

describe('leaveCursorQueriesToMain', () => {
  it('does not answer cursor-position queries', async () => {
    expect(await repliesTo('\x1b[6n\x1b[?6n')).toEqual([]);
  });

  it('still answers other queries', async () => {
    expect(await repliesTo('\x1b[5n\x1b[c')).toEqual(['\x1b[0n', '\x1b[?1;2c']);
  });
});
