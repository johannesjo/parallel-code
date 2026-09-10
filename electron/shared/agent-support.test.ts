import { describe, expect, it } from 'vitest';
import { isAgentSupportedInMode } from './agent-support.js';

describe('isAgentSupportedInMode', () => {
  it.each(['kimi', '/opt/bin/kimi'])('requires Docker for %s', (command) => {
    expect(isAgentSupportedInMode(command)).toBe(false);
    expect(isAgentSupportedInMode(command, false)).toBe(false);
    expect(isAgentSupportedInMode(command, true)).toBe(true);
  });

  it.each(['claude', 'codex', 'gemini', '/bin/zsh', 'kimi-wrapper'])(
    'preserves native support for %s',
    (command) => expect(isAgentSupportedInMode(command)).toBe(true),
  );
});
