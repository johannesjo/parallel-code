import { describe, expect, it } from 'vitest';

import {
  askCodeEnvFile,
  defaultAskCodeModel,
  isAskCodeEffort,
  isAskCodeModel,
} from './ask-code-models.js';

const ENV_FILES = { 'claude-code': '/env/claude.env', codex: '/env/codex.env' };

describe('askCodeEnvFile', () => {
  it('gives each CLI provider its own agent env file', () => {
    expect(askCodeEnvFile('claude', ENV_FILES)).toBe('/env/claude.env');
    expect(askCodeEnvFile('codex', ENV_FILES)).toBe('/env/codex.env');
  });

  it('leaves a provider without a configured env file undefined', () => {
    expect(askCodeEnvFile('codex', { 'claude-code': '/env/claude.env' })).toBeUndefined();
    expect(askCodeEnvFile('claude', {})).toBeUndefined();
  });

  it('has no env file for MiniMax, which is an HTTP call with a stored key', () => {
    expect(askCodeEnvFile('minimax', ENV_FILES)).toBeUndefined();
  });
});

describe('ask-code model guards', () => {
  it('accepts each provider’s own model shape only', () => {
    expect(isAskCodeModel('claude', 'sonnet')).toBe(true);
    expect(isAskCodeModel('claude', 'gpt-5.6-luna')).toBe(false);
    expect(isAskCodeModel('codex', 'gpt-5.6-luna')).toBe(true);
    expect(isAskCodeModel('codex', '-- rm -rf /')).toBe(false);
  });

  it('leaves the Codex model to the CLI until one is picked', () => {
    expect(defaultAskCodeModel('codex')).toBe('');
    expect(defaultAskCodeModel('claude')).toBe('sonnet');
  });
});

describe('isAskCodeEffort', () => {
  it('accepts only the levels the provider CLI takes', () => {
    expect(isAskCodeEffort('claude', 'high')).toBe(true);
    expect(isAskCodeEffort('claude', 'minimal')).toBe(false);
    expect(isAskCodeEffort('codex', 'minimal')).toBe(true);
    expect(isAskCodeEffort('minimax', 'high')).toBe(false);
    expect(isAskCodeEffort('claude', 'high" --danger')).toBe(false);
  });
});
