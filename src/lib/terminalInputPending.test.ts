import { describe, expect, it } from 'vitest';
import { hasTerminalUserActivity, nextTerminalInputPending } from './terminalInputPending';

describe('nextTerminalInputPending', () => {
  it('marks printable terminal input as pending', () => {
    expect(nextTerminalInputPending(false, 'hello')).toBe(true);
  });

  it('marks pasted terminal text as pending', () => {
    expect(nextTerminalInputPending(false, 'line one\nline two')).toBe(true);
  });

  it('clears pending input on Enter', () => {
    expect(nextTerminalInputPending(true, '\r')).toBe(false);
    expect(nextTerminalInputPending(false, 'hello\r')).toBe(false);
  });

  it('clears pending input on Ctrl-C and Ctrl-U', () => {
    expect(nextTerminalInputPending(true, '\x03')).toBe(false);
    expect(nextTerminalInputPending(true, '\x15')).toBe(false);
    expect(nextTerminalInputPending(false, 'hello\x15')).toBe(false);
  });

  it('keeps a draft pending when Shift+Enter inserts a newline', () => {
    expect(nextTerminalInputPending(true, '\x1b\r')).toBe(true);
    expect(hasTerminalUserActivity('\x1b\r')).toBe(true);
  });

  it('does not mistake Alt word navigation for typed text', () => {
    expect(nextTerminalInputPending(false, '\x1bb')).toBe(false);
    expect(hasTerminalUserActivity('\x1bb')).toBe(true);
  });

  it('does not mark cursor escape sequences as pending input', () => {
    expect(nextTerminalInputPending(false, '\x1b[A')).toBe(false);
    expect(nextTerminalInputPending(false, '\x1b[B')).toBe(false);
    expect(nextTerminalInputPending(true, '\x1b[D')).toBe(true);
  });

  it('does not treat terminal focus events as user activity', () => {
    expect(hasTerminalUserActivity('\x1b[I')).toBe(false);
    expect(hasTerminalUserActivity('\x1b[O')).toBe(false);
    expect(nextTerminalInputPending(false, '\x1b[I')).toBe(false);
    expect(nextTerminalInputPending(false, '\x1b[O')).toBe(false);
  });

  it.each([
    '\x1b]10;rgb:ffff/ffff/ffff\x1b\\',
    '\x1b]11;rgb:0000/0000/0000\x07',
    '\x1bP>|xterm.js(5.5.0)\x1b\\',
    '\x1b[?1;2c',
    '\x1b[>0;276;0c',
    '\x1b[1;1R',
    '\x1b[?1u',
    // Mode reports (DECRPM); Claude Code queries modes with DECRQM.
    '\x1b[?2026;2$y',
    '\x1b[4;2$y',
  ])('ignores automatic terminal reply %j without changing a draft', (reply) => {
    expect(nextTerminalInputPending(false, reply)).toBe(false);
    expect(nextTerminalInputPending(true, reply)).toBe(true);
    expect(hasTerminalUserActivity(reply)).toBe(false);
    expect(nextTerminalInputPending(false, `${reply}hello`)).toBe(true);
    expect(hasTerminalUserActivity(`${reply}hello`)).toBe(true);
  });

  // Full-screen TUIs such as Codex enable any-motion SGR mouse tracking; pointer
  // movement over the pane must not read as a draft that holds back peer prompts.
  it.each(['\x1b[<35;10;5M', '\x1b[<0;12;3M', '\x1b[<0;12;3m', '\x1b[<64;1;1M'])(
    'ignores SGR mouse report %j without changing a draft',
    (report) => {
      expect(hasTerminalUserActivity(report)).toBe(false);
      expect(nextTerminalInputPending(false, report)).toBe(false);
      expect(nextTerminalInputPending(true, report)).toBe(true);
      expect(hasTerminalUserActivity(`${report}hello`)).toBe(true);
    },
  );

  it('does not mistake application cursor keys for typed text', () => {
    expect(nextTerminalInputPending(false, '\x1bOA')).toBe(false);
    expect(hasTerminalUserActivity('\x1bOA')).toBe(true);
  });

  it('treats non-focus terminal input as user activity', () => {
    expect(hasTerminalUserActivity('hello')).toBe(true);
    expect(hasTerminalUserActivity('\r')).toBe(true);
    expect(hasTerminalUserActivity('\x1b[A')).toBe(true);
    expect(hasTerminalUserActivity('\x7f')).toBe(true);
  });

  it('ignores bracketed paste markers but keeps pasted text pending', () => {
    expect(nextTerminalInputPending(false, '\x1b[200~hello\x1b[201~')).toBe(true);
    expect(nextTerminalInputPending(false, '\x1b[200~hello\n\x1b[201~')).toBe(true);
    expect(nextTerminalInputPending(false, '\x1b[200~hello\n\x1b[201~\r')).toBe(false);
  });

  it('does not make a backspace on a clean line pending', () => {
    expect(nextTerminalInputPending(false, '\x7f')).toBe(false);
    expect(nextTerminalInputPending(true, '\x7f')).toBe(true);
  });
});
