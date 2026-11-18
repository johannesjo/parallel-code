// What the desktop's terminal engine shows for a set of terminal streams,
// shared with the Android app. The app draws terminals with its own emulator
// (android/.../TerminalScreen.kt); its TerminalGoldenTest feeds the same
// bytes and must show the same lines. Each stream is also checked as the
// rendered snapshot the server sends when a phone opens a terminal.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import headless from '@xterm/headless';
import serializeAddon from '@xterm/addon-serialize';
import { format } from 'prettier';
import { describe, expect, it } from 'vitest';

const { Terminal } = headless;
const { SerializeAddon } = serializeAddon;

const GOLDEN_PATH = join(
  import.meta.dirname,
  '../../android/app/src/test/resources/terminal-golden.json',
);

const ESC = '\x1b';
const CSI = `${ESC}[`;

interface Stream {
  name: string;
  cols: number;
  rows: number;
  data: string;
}

/** The kinds of output that have broken on phones: wraps, repaints, full-screen apps, scrolling. */
const STREAMS: Stream[] = [
  { name: 'exact-width line then newline', cols: 5, rows: 3, data: 'abcde\r\nf' },
  { name: 'long line wraps', cols: 4, rows: 4, data: 'abcdefghij\r\nk' },
  { name: 'wrapped words keep their spaces', cols: 6, rows: 3, data: 'one two three' },
  { name: 'history scrolls off the top', cols: 6, rows: 2, data: '1\r\n2\r\n3\r\n4\r\n5' },
  {
    name: 'colors leave text alone',
    cols: 20,
    rows: 2,
    data: `${CSI}1;31mred${CSI}0m ${CSI}38;5;42mok${CSI}m`,
  },
  {
    name: 'cursor moves and erase',
    cols: 10,
    rows: 3,
    data: `hello\r\nworld${CSI}1;1Hj${CSI}2;3H${CSI}K`,
  },
  { name: 'erase display', cols: 8, rows: 3, data: `aaaa\r\nbbbb\r\ncccc${CSI}2;3H${CSI}J` },
  { name: 'tabs', cols: 20, rows: 2, data: 'a\tb\tc' },
  { name: 'backspace', cols: 10, rows: 2, data: 'abc\b\bX' },
  {
    name: 'insert and delete characters',
    cols: 10,
    rows: 2,
    data: `abcdef${CSI}1;3H${CSI}2P${CSI}1;2H${CSI}1@`,
  },
  {
    name: 'insert and delete lines',
    cols: 6,
    rows: 4,
    data: `1\r\n2\r\n3\r\n4${CSI}2;1H${CSI}L${CSI}4;1H${CSI}M`,
  },
  {
    name: 'status line below a scroll region',
    cols: 8,
    rows: 3,
    data: `${CSI}3;1Hstatus${CSI}1;2r${CSI}1;1Ha\r\nb\r\nc\r\nd`,
  },
  { name: 'save and restore cursor', cols: 10, rows: 2, data: `ab${ESC}7cd\r\nxy${ESC}8Z` },
  {
    // How agents redraw their prompt box: move up, clear each line, draw it again.
    name: 'prompt box repaint',
    cols: 12,
    rows: 5,
    data: `out\r\n╭──────╮\r\n│ hi   │\r\n╰──────╯${CSI}2A\r${CSI}2K${CSI}1B\r${CSI}2K${CSI}1A\r│ done │\r\n╰──────╯`,
  },
  {
    name: 'full-screen app hides history',
    cols: 10,
    rows: 3,
    data: `shell1\r\nshell2\r\n${CSI}?1049h${CSI}H${CSI}2Japp`,
  },
  {
    name: 'leaving a full-screen app restores the shell',
    cols: 10,
    rows: 3,
    data: `shell1\r\n${CSI}?1049h${CSI}H${CSI}2Japp${CSI}?1049l$ `,
  },
  {
    name: 'title sequences are hidden',
    cols: 10,
    rows: 2,
    data: `${ESC}]0;title\x07ok${ESC}]8;;https://x.dev${ESC}\\link${ESC}]8;;${ESC}\\`,
  },
  { name: 'accents and box drawing', cols: 10, rows: 2, data: 'café ─┼─ ✓' },
  // Wide characters take two cells, so they wrap earlier than their character count suggests.
  { name: 'wide characters', cols: 6, rows: 3, data: '日本語ab\r\n✅ ok' },
  { name: 'wide character at the last column wraps whole', cols: 5, rows: 3, data: '日本語x' },
  {
    name: 'wide character wrapping from the last column clears it',
    cols: 5,
    rows: 3,
    data: `abcde${CSI}1;5H日`,
  },
  { name: 'combining marks share a cell', cols: 4, rows: 3, data: 'e\u0301e\u0301xyz' },
  // xterm's default Unicode 6 widths count this emoji as one cell.
  { name: 'astral emoji', cols: 4, rows: 3, data: '🤖abcd' },
  {
    name: 'overwriting half a wide character',
    cols: 6,
    rows: 2,
    data: `日本${CSI}1;2Hx${CSI}1;3Hy`,
  },
  // Shifting or blanking one half of a wide character blanks the whole character.
  { name: 'delete at a wide character', cols: 6, rows: 2, data: `中ab\r${CSI}1P` },
  {
    name: 'insert pushes a wide character off the edge',
    cols: 4,
    rows: 2,
    data: `ab中${CSI}1G${CSI}1@`,
  },
  { name: 'erase half a wide character', cols: 6, rows: 2, data: `中ab${CSI}2G${CSI}1X` },
  {
    name: 'erase to the end from inside a wide character',
    cols: 6,
    rows: 2,
    data: `a中b${CSI}3G${CSI}K`,
  },
  {
    name: 'erase to the cursor on a wide character',
    cols: 6,
    rows: 2,
    data: `a中b${CSI}2G${CSI}1K`,
  },
];

interface GoldenCase {
  name: string;
  cols: number;
  rows: number;
  /** Base64 of the bytes to feed. */
  data: string;
  /** What the screen shows: history then screen (the screen alone in a full-screen app), trimmed. */
  lines: string[];
  /** The same text with wrapped rows joined back into their line, as the phone copies it. */
  copy: string;
}

function write(term: InstanceType<typeof Terminal>, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function shown(term: InstanceType<typeof Terminal>): { lines: string[]; copy: string } {
  // The alternate buffer holds only the screen, so a full-screen app shows without history.
  const buffer = term.buffer.active;
  const rows: { text: string; full: string; wrapped: boolean }[] = [];
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    // Spaces a program wrote still count as content to xterm; the phone trims them like blanks.
    if (!line) continue;
    rows.push({
      text: line.translateToString(true).trimEnd(),
      full: line.translateToString(false),
      wrapped: line.isWrapped,
    });
  }
  while (rows.length > 0 && rows[rows.length - 1].text === '') rows.pop();
  const copy: string[] = [];
  rows.forEach((row, i) => {
    const next = rows[i + 1];
    // A row the next one continues keeps its trailing blanks: they sit between two words.
    const text = next?.wrapped ? row.full : row.text;
    if (row.wrapped && copy.length > 0) copy[copy.length - 1] += text;
    else copy.push(text);
  });
  return { lines: rows.map((r) => r.text), copy: copy.join('\n').trimEnd() };
}

async function render(
  stream: Stream,
): Promise<{ shown: ReturnType<typeof shown>; snapshot: string }> {
  const term = new Terminal({
    cols: stream.cols,
    rows: stream.rows,
    scrollback: 1000,
    allowProposedApi: true,
  });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  await write(term, stream.data);
  const result = { shown: shown(term), snapshot: serializer.serialize() };
  term.dispose();
  return result;
}

async function goldenCases(): Promise<GoldenCase[]> {
  const cases: GoldenCase[] = [];
  for (const stream of STREAMS) {
    const { shown: expected, snapshot } = await render(stream);
    const base = { cols: stream.cols, rows: stream.rows, ...expected };
    cases.push({ ...base, name: stream.name, data: Buffer.from(stream.data).toString('base64') });
    cases.push({
      ...base,
      name: `${stream.name} (snapshot)`,
      data: Buffer.from(snapshot).toString('base64'),
    });
  }
  return cases;
}

describe('terminal golden cases shared with the Android app', () => {
  it('a snapshot shows what its stream showed', async () => {
    for (const stream of STREAMS) {
      const { shown: expected, snapshot } = await render(stream);
      const { shown: replayed } = await render({ ...stream, data: snapshot });
      expect(replayed, stream.name).toEqual(expected);
    }
  });

  it('match the committed JSON (UPDATE_TERMINAL_GOLDEN=1 rewrites it)', async () => {
    const cases = await goldenCases();
    if (process.env.UPDATE_TERMINAL_GOLDEN === '1') {
      writeFileSync(GOLDEN_PATH, await format(JSON.stringify(cases), { parser: 'json' }));
    }
    const committed: unknown = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
    expect(committed).toEqual(cases);
  });
});
