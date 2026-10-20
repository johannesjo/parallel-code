import { expect, it } from 'vitest';
import { codexResumeId, isCodexUnsavedSessionExit } from './codex-resume.js';

const id = '01999999-1234-4321-9876-0123456789ab';
it('recognizes only an explicit unsaved-session exit footer', () => {
  expect(isCodexUnsavedSessionExit(`\r\nSession ID: \x1b[32m${id}\x1b[0m\r\n`)).toBe(true);
  expect(isCodexUnsavedSessionExit(`Session ID: ${id}\nMore agent output`)).toBe(false);
  expect(isCodexUnsavedSessionExit('Session ID: invalid')).toBe(false);
  expect(isCodexUnsavedSessionExit(`Example: Session ID: ${id}`)).toBe(false);
});
it('reads an ANSI-coloured Codex exit footer', () => {
  expect(
    codexResumeId(
      `Tokens: 123\r\nTo continue this session, run \x1b[32mcodex resume ${id}\x1b[0m\r\n`,
    ),
  ).toBe(id);
});
it.each([
  `Example: codex resume ${id}`,
  `To continue this session, run codex resume ${id}\nMore agent output`,
  'To continue this session, run codex resume --last',
  'To continue this session, run codex resume invalid',
])('does not mistake example output or a latest-session command for an exit footer', (output) => {
  expect(codexResumeId(output)).toBeUndefined();
});

it('reads the current CLI multiline footer after a terminal screen restore', () => {
  expect(
    codexResumeId(
      `Shutting down...\x1b[?25hTo continue this session, run:\r\n  codex resume ${id}\r\n`,
    ),
  ).toBe(id);
});
