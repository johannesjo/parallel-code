import headless from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { handleOsc52Writes, OSC52_MAX_BASE64_LENGTH, parseOsc52Write } from './terminalClipboard';

const base64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

describe('parseOsc52Write', () => {
  it('decodes UTF-8 text for any selection target', () => {
    expect(parseOsc52Write(`c;${base64('héllo ✓\nline 2')}`)).toBe('héllo ✓\nline 2');
    expect(parseOsc52Write(`;${base64('hello')}`)).toBe('hello');
    expect(parseOsc52Write(`p;${base64('hello')}`)).toBe('hello');
  });

  it('accepts unpadded base64', () => {
    expect(parseOsc52Write('c;aGVsbG8')).toBe('hello');
  });

  it.each([
    ['a clipboard query', 'c;?'],
    ['a clear request', 'c;'],
    ['a missing target separator', base64('hello')],
    ['invalid base64 characters', 'c;aGVs!G8='],
    ['an impossible base64 length', 'c;aGVsb'],
    ['misplaced padding', 'c;aG=sbG8='],
    ['padding alone', 'c;=='],
  ])('ignores %s', (_name, data) => {
    expect(parseOsc52Write(data)).toBeUndefined();
  });

  it('accepts padding even when the padded length is off', () => {
    expect(parseOsc52Write('c;aGk=')).toBe('hi');
    expect(parseOsc52Write('c;aGk')).toBe('hi');
    expect(parseOsc52Write('c;aGk==')).toBe('hi');
  });

  it('never throws on base64-like input', () => {
    // atob throws on some of these (e.g. `AB=`); an exception inside xterm's
    // parser stalls the pane for good.
    const alphabet = 'AB+/=';
    // Collect throwers and assert once: an expect per payload made ~100k calls
    // that hit the 5s timeout on loaded or Windows runners.
    const throwing: string[] = [];
    for (let length = 1; length <= 7; length++) {
      for (let n = 0; n < alphabet.length ** length; n++) {
        let payload = '';
        for (let rest = n, i = 0; i < length; i++, rest = Math.floor(rest / alphabet.length)) {
          payload += alphabet[rest % alphabet.length];
        }
        try {
          parseOsc52Write(`c;${payload}`);
        } catch {
          throwing.push(payload);
        }
      }
    }
    expect(throwing).toEqual([]);
  });

  it('ignores payloads over the size cap', () => {
    expect(parseOsc52Write(`c;${'A'.repeat(OSC52_MAX_BASE64_LENGTH)}`)).toBeDefined();
    expect(parseOsc52Write(`c;${'A'.repeat(OSC52_MAX_BASE64_LENGTH + 4)}`)).toBeUndefined();
  });
});

describe('handleOsc52Writes', () => {
  // The headless build shares xterm's parser, so it stands in for the renderer's xterm.
  async function run(output: string, allowed: boolean) {
    const term = new headless.Terminal({ cols: 80, rows: 24 });
    const writes: string[] = [];
    const replies: string[] = [];
    handleOsc52Writes(term, { allowed: () => allowed, write: (text) => writes.push(text) });
    term.onData((data) => replies.push(data));
    await new Promise<void>((resolve) => term.write(output, resolve));
    term.dispose();
    return { writes, replies };
  }

  it('writes copied text when allowed', async () => {
    const output = `\x1b]52;c;${base64('copied')}\x07\x1b]52;c;${base64('again')}\x1b\\`;
    expect(await run(output, true)).toEqual({ writes: ['copied', 'again'], replies: [] });
  });

  it('drops writes when not allowed', async () => {
    expect((await run(`\x1b]52;c;${base64('copied')}\x07`, false)).writes).toEqual([]);
  });

  it('keeps parsing output after a malformed payload', async () => {
    const term = new headless.Terminal({ cols: 80, rows: 24 });
    handleOsc52Writes(term, { allowed: () => true, write: () => undefined });
    await new Promise<void>((resolve) => term.write('before\x1b]52;c;AB=\x07after', resolve));
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('beforeafter');
    term.dispose();
  });

  it('never answers clipboard queries', async () => {
    expect(await run('\x1b]52;c;?\x07', true)).toEqual({ writes: [], replies: [] });
  });
});
