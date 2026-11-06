import { describe, expect, it } from 'vitest';
import { submitsTerminalDraft } from './terminal-input.js';

describe('submitsTerminalDraft', () => {
  it('submits a draft typed in the same chunk as its Enter', () => {
    expect(submitsTerminalDraft(false, 'follow-up\r')).toBe(true);
    expect(submitsTerminalDraft(false, 'follow-up\x1b[13u')).toBe(true);
  });

  it('submits a pending draft on a plain or kitty Enter', () => {
    expect(submitsTerminalDraft(true, '\r')).toBe(true);
    expect(submitsTerminalDraft(true, '\x1b[13;1u')).toBe(true);
  });

  it('does not submit an empty line', () => {
    expect(submitsTerminalDraft(false, '\r')).toBe(false);
    expect(submitsTerminalDraft(false, '\x1b[13u')).toBe(false);
  });

  it('does not submit on newlines or kitty Enter inside a paste', () => {
    expect(submitsTerminalDraft(false, '\x1b[200~one\rtwo\x1b[201~')).toBe(false);
    expect(submitsTerminalDraft(false, '\x1b[200~one\x1b[13utwo\x1b[201~')).toBe(false);
  });

  it('does not submit on Shift+Enter or a cleared line', () => {
    expect(submitsTerminalDraft(true, '\x1b[13;2u')).toBe(false);
    expect(submitsTerminalDraft(true, '\x03')).toBe(false);
    expect(submitsTerminalDraft(true, '\x15')).toBe(false);
  });
});
