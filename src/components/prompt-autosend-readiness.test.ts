import { describe, expect, it } from 'vitest';
import {
  isMenuBlockingAutoSend,
  isScreenBlockingAutoSend,
  isStartupBlockingAutoSend,
  shouldAbortInitialPromptAfterTimeout,
} from './prompt-autosend-readiness';
import { looksLikeQuestion, normalizeCurrentFrame } from '../store/taskStatus';

describe('isStartupBlockingAutoSend', () => {
  it('blocks while Codex is still loading the model', () => {
    expect(isStartupBlockingAutoSend('model: loading   /model to change\n›')).toBe(true);
  });

  it('blocks while Codex is starting MCP servers', () => {
    expect(
      isStartupBlockingAutoSend(
        'Starting MCP servers (0/2): codex_apps, parallel-code\n› Explain this codebase',
      ),
    ).toBe(true);
  });

  it('blocks while Codex is booting a single MCP server', () => {
    expect(isStartupBlockingAutoSend('Booting MCP server: parallel-code\n›')).toBe(true);
  });

  it('ignores stale startup text before the latest screen clear', () => {
    const tail = 'Starting MCP servers (0/2): parallel-code\x1b[2J\x1b[H›';
    expect(isStartupBlockingAutoSend(tail)).toBe(false);
  });

  it('blocks while Codex is booting multiple MCP servers (plural form)', () => {
    expect(isStartupBlockingAutoSend('Booting MCP servers: parallel-code\n›')).toBe(true);
  });

  it('blocks during mid-redraw: screen-clear issued but new frame not yet drawn', () => {
    // Codex emits \x1b[2J\x1b[H to start a new frame, but no content has arrived yet.
    // normalizeCurrentFrame returns '' in this window — treat as blocking so we
    // don't start stability checks against an empty snapshot.
    const tail = 'model: loading...\x1b[2J\x1b[H';
    expect(isStartupBlockingAutoSend(tail)).toBe(true);
  });

  it('blocks during cursor-home-only mid-redraw (no screen clear)', () => {
    const tail = 'Starting MCP servers (1/2)\x1b[H';
    expect(isStartupBlockingAutoSend(tail)).toBe(true);
  });

  it('does not block when the current frame has visible non-startup content', () => {
    // A screen clear followed by something unrelated to startup is ready.
    expect(isStartupBlockingAutoSend('\x1b[2J\x1b[H›')).toBe(false);
  });
});

describe('normalizeCurrentFrame (used to gate initial-prompt delivery)', () => {
  it('returns falsy while no renderer tail has been observed', () => {
    expect(normalizeCurrentFrame('')).toBeFalsy();
  });

  it('returns falsy for control-only renderer output', () => {
    expect(normalizeCurrentFrame('\x1b[?2004h\x1b[?1004h')).toBeFalsy();
  });

  it('returns truthy once any renderer tail has been observed', () => {
    expect(normalizeCurrentFrame('› Explain this codebase')).toBeTruthy();
  });
});

describe('shouldAbortInitialPromptAfterTimeout', () => {
  it('does not abort before the readiness timeout', () => {
    expect(
      shouldAbortInitialPromptAfterTimeout({
        elapsedMs: 44_999,
        maxWaitMs: 45_000,
        coordinatedBy: undefined,
        tail: '› Explain this codebase',
      }),
    ).toBe(false);
  });

  it('keeps coordinated sub-task initial assignments alive after the readiness timeout', () => {
    expect(
      shouldAbortInitialPromptAfterTimeout({
        elapsedMs: 45_001,
        maxWaitMs: 45_000,
        coordinatedBy: 'coordinator-1',
        tail: '› Explain this codebase',
      }),
    ).toBe(false);
  });

  it('keeps prompt delivery alive after timeout when no renderer tail has been observed', () => {
    expect(
      shouldAbortInitialPromptAfterTimeout({
        elapsedMs: 45_001,
        maxWaitMs: 45_000,
        coordinatedBy: undefined,
        tail: '',
      }),
    ).toBe(false);
  });

  it('aborts non-coordinated initial prompts after timeout once output is visible', () => {
    expect(
      shouldAbortInitialPromptAfterTimeout({
        elapsedMs: 45_001,
        maxWaitMs: 45_000,
        coordinatedBy: undefined,
        tail: '› Explain this codebase',
      }),
    ).toBe(true);
  });
});

/** Codex 0.166.0's startup as #336 describes it: bracketed paste, the
 *  alternate screen, the composer, then the update menu drawn over it with
 *  cursor moves only — no newlines and no screen clear. */
const CODEX_UPDATE_MENU_TAIL = [
  '\x1b[?2004h\x1b[?1049h',
  '\x1b[20;1H› Ask Codex to do anything\x1b[22;1H? for shortcuts',
  '\x1b[2;3HUpdate available · 0.166.0 → 99.0.0',
  '\x1b[4;3HRelease notes: https://github.com/openai/codex/releases/latest',
  '\x1b[6;1H› 1. Update now (runs `npm install -g @openai/codex`)',
  '\x1b[7;3H2. Skip\x1b[8;3H3. Skip until next version',
  '\x1b[10;3Henter continue · esc skip',
].join('');

describe('isMenuBlockingAutoSend', () => {
  it("blocks on Codex's update menu drawn over its composer (#336)", () => {
    expect(isMenuBlockingAutoSend(CODEX_UPDATE_MENU_TAIL)).toBe(true);
    expect(isScreenBlockingAutoSend(CODEX_UPDATE_MENU_TAIL)).toBe(true);
  });

  it('blocks on a numbered login menu', () => {
    const tail =
      '\x1b[1;1HSign in\x1b[3;1H› 1. Sign in with ChatGPT\x1b[4;3H2. Provide your own API key';
    expect(isMenuBlockingAutoSend(tail)).toBe(true);
  });

  it('lets the send through once the composer is drawn below the menu', () => {
    const tail = `${CODEX_UPDATE_MENU_TAIL}\x1b[2J\x1b[20;1H› Ask Codex to do anything`;
    expect(isMenuBlockingAutoSend(tail)).toBe(false);
  });

  it('does not block a plain ready composer', () => {
    expect(isMenuBlockingAutoSend('\x1b[20;1H› Ask Codex to do anything')).toBe(false);
    expect(isScreenBlockingAutoSend('\x1b[20;1H› Ask Codex to do anything')).toBe(false);
  });

  it('leaves the startup check alone, which also gates question handoff', () => {
    expect(isStartupBlockingAutoSend(CODEX_UPDATE_MENU_TAIL)).toBe(false);
  });
});

describe('an answered update menu', () => {
  /** Skip picked: the menu rows erased and the composer redrawn below, no clear. */
  const answered = `${CODEX_UPDATE_MENU_TAIL}\x1b[6;1H\x1b[K\x1b[7;1H\x1b[K\x1b[8;1H\x1b[K\x1b[20;1H› Ask Codex to do anything`;

  it('no longer holds the send', () => {
    expect(isScreenBlockingAutoSend(answered)).toBe(false);
  });

  it('is no longer a question, so the queued prompt can go', () => {
    expect(looksLikeQuestion(CODEX_UPDATE_MENU_TAIL)).toBe(true);
    expect(looksLikeQuestion(answered)).toBe(false);
  });
});
