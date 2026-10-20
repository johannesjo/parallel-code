import { describe, expect, it } from 'vitest';
import {
  canAssignSessionId,
  canResumeSessionId,
  newSessionArgs,
  resumeSessionArgs,
} from './session-resume.js';

const ID = 'fb4f2bc6-62d9-4b29-a795-240caf2fc459';

describe('newSessionArgs', () => {
  it('names a new Claude session', () => {
    expect(newSessionArgs('claude', ID)).toEqual(['--session-id', ID]);
  });

  it('works for an absolute path to the CLI', () => {
    expect(newSessionArgs('/opt/homebrew/bin/claude', ID)).toEqual(['--session-id', ID]);
  });

  // Codex can resume an id but cannot be handed one up front; emitting a flag
  // it does not know would break the launch outright.
  it('returns null for Codex', () => {
    expect(newSessionArgs('codex', ID)).toBeNull();
  });

  it.each(['gemini', 'copilot', 'opencode', 'agy'])('returns null for %s', (command) => {
    expect(newSessionArgs(command, ID)).toBeNull();
  });
});

describe('resumeSessionArgs', () => {
  it('resumes a specific Claude session', () => {
    expect(resumeSessionArgs('claude', ID)).toEqual(['--resume', ID]);
  });

  it('resumes a specific Codex session positionally', () => {
    expect(resumeSessionArgs('codex', ID)).toEqual(['resume', ID]);
  });

  it('matches a versioned codex binary name', () => {
    expect(resumeSessionArgs('codex-cli', ID)).toEqual(['resume', ID]);
  });

  it.each(['gemini', 'copilot', 'opencode', 'agy'])(
    'returns null for %s so it keeps its positional resume',
    (command) => {
      expect(resumeSessionArgs(command, ID)).toBeNull();
    },
  );
});

describe('canAssignSessionId', () => {
  it('is true for Claude, which honours an id we choose', () => {
    expect(canAssignSessionId('claude')).toBe(true);
  });

  // The distinction that keeps PC from inventing a Codex session id it could
  // never resume.
  it('is false for Codex even though Codex can resume an id', () => {
    expect(canAssignSessionId('codex')).toBe(false);
    expect(canResumeSessionId('codex')).toBe(true);
  });

  it.each(['gemini', 'opencode', 'agy', 'copilot'])('is false for %s', (command) => {
    expect(canAssignSessionId(command)).toBe(false);
  });
});

describe('canResumeSessionId', () => {
  it.each([
    ['claude', true],
    ['codex', true],
    ['gemini', false],
    ['opencode', false],
  ])('%s -> %s', (command, expected) => {
    expect(canResumeSessionId(command)).toBe(expected);
  });
});

// A session id is read out of a transcript file, or out of the saved profile,
// and then becomes an argument to a spawned CLI. `claude --resume` takes an
// *optional* argument and `codex resume` takes a positional, so a value
// starting with a dash is parsed by both as a flag of its own. These builders
// are the last gate before argv, so they re-check what the scanner already
// checked rather than trusting their caller.
describe('session id validation', () => {
  const REJECTED = [
    '--dangerously-skip-permissions',
    '--dangerously-bypass-approvals-and-sandbox',
    '-r',
    '',
    'not-a-uuid',
    // Right length and layout, but not hex.
    'zzzzzzzz-62d9-4b29-a795-240caf2fc459',
    // Trailing junk after a real id.
    `${ID} --dangerously-skip-permissions`,
    `${ID}\n--dangerously-skip-permissions`,
  ];

  it.each(REJECTED)('refuses to build resume args for %j', (bad) => {
    expect(resumeSessionArgs('claude', bad)).toBeNull();
    expect(resumeSessionArgs('codex', bad)).toBeNull();
  });

  it.each(REJECTED)('refuses to build new-session args for %j', (bad) => {
    expect(newSessionArgs('claude', bad)).toBeNull();
  });

  // Codex writes v7 and Claude v4, so the check is on the hex shape rather than
  // the version nibble — a future version bump must not empty the picker.
  it.each([
    ['v4, as Claude writes', 'fb4f2bc6-62d9-4b29-a795-240caf2fc459'],
    ['v7, as Codex writes', '01a08a73-a660-7963-bc3d-0b296b002046'],
    ['uppercase', 'FB4F2BC6-62D9-4B29-A795-240CAF2FC459'],
  ])('accepts %s', (_label, id) => {
    expect(resumeSessionArgs('claude', id)).toEqual(['--resume', id]);
    expect(resumeSessionArgs('codex', id)).toEqual(['resume', id]);
  });

  // The capability checks answer a question about the CLI, not about any
  // particular id, so an unusable id must not make a CLI look incapable.
  it('reports capability independently of any id', () => {
    expect(canAssignSessionId('claude')).toBe(true);
    expect(canResumeSessionId('codex')).toBe(true);
  });
});
