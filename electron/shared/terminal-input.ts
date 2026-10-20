function isCsiTerminator(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

function skipEscapeSequence(data: string, index: number): number {
  const kind = data[index + 1];
  // xterm sends OSC color replies and DCS capability replies through onData,
  // just like keystrokes. Their payload is not a composer draft.
  if (kind === ']' || kind === 'P') {
    for (let i = index + 2; i < data.length; i++) {
      if (data[i] === '\x07') return i;
      if (data[i] === '\x1b' && data[i + 1] === '\\') return i + 1;
    }
    return data.length - 1;
  }
  if (kind === '[' || kind === 'O') {
    let i = index + 2;
    while (i < data.length) {
      if (isCsiTerminator(data[i])) return i;
      i++;
    }
    return data.length - 1;
  }
  // Alt/Meta keys are ESC followed by one character. Consume both so word
  // navigation isn't a draft and Shift+Enter isn't mistaken for submission.
  return kind === undefined ? index : index + 1;
}

function isTerminalReport(data: string, start: number, end: number): boolean {
  const seq = data.slice(start, end + 1);
  return (
    seq === '\x1b[I' ||
    seq === '\x1b[O' ||
    seq.startsWith('\x1b]') ||
    seq.startsWith('\x1bP') ||
    // Device attributes, cursor position, status, mode and keyboard-protocol
    // replies, plus SGR mouse reports: Codex tracks every pointer move, and a
    // move over its pane must not count as a draft that blocks second-opinion delivery.
    // eslint-disable-next-line no-control-regex
    /^\x1b\[(?:[?>]?[\d;]*c|\??\d+;\d+R|\d+n|\??\d+;\d+\$y|\?\d+u|<\d+;\d+;\d+[Mm])$/.test(seq)
  );
}

export function hasTerminalUserActivity(data: string): boolean {
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === '\x1b') {
      const end = skipEscapeSequence(data, i);
      if (!isTerminalReport(data, i, end)) return true;
      i = end;
    } else if (ch === '\r' || ch === '\n' || ch === '\x03' || ch === '\x15') {
      return true;
    } else if (ch === '\x7f') {
      return true;
    } else if (ch >= ' ') {
      return true;
    }
  }
  return false;
}

// Cursor movement, Alt word movement, editing and function keys (optionally
// modified): none can put text on an empty line. ↑/↓ are absent because
// history recall can.
// eslint-disable-next-line no-control-regex
const NON_DRAFT_KEY = /^\x1b(?:[bf]|\[(?:1;\d+)?[CDHF]|O[CDHFPQRS]|\[1;\d+[PQRS]|\[\d+(?:;\d+)?~)$/;

/**
 * Whether input may have left a draft in the agent's prompt. Unknown escape
 * sequences count, so a key encoding not listed here errs towards holding
 * back peer prompts rather than pasting into a draft.
 */
export function hasTerminalDraftActivity(data: string): boolean {
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === '\x1b') {
      // Escape, alone or before another Escape or Backspace, cannot create a draft.
      if (data[i + 1] === undefined || data[i + 1] === '\x1b' || data[i + 1] === '\x7f') continue;
      const end = skipEscapeSequence(data, i);
      const seq = data.slice(i, end + 1);
      if (!isTerminalReport(data, i, end) && !NON_DRAFT_KEY.test(seq)) return true;
      i = end;
    } else if (ch !== '\x7f') {
      return true;
    }
  }
  return false;
}

export function nextTerminalInputPending(currentPending: boolean, data: string): boolean {
  let pending = currentPending;
  let inPaste = false;
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === '\x1b') {
      const end = skipEscapeSequence(data, i);
      const sequence = data.slice(i, end + 1);
      if (sequence === '\x1b[200~') inPaste = true;
      else if (sequence === '\x1b[201~') inPaste = false;
      i = end;
    } else if (inPaste) {
      // Newlines inside bracketed paste insert text; only a later Enter submits.
      pending = true;
    } else if (ch === '\r' || ch === '\n' || ch === '\x03' || ch === '\x15') {
      pending = false;
    } else if (ch === '\x7f') {
      // Backspace: can't know if line is now empty without a char counter; leave pending unchanged.
    } else if (ch >= ' ') {
      pending = true;
    }
  }
  return pending;
}
