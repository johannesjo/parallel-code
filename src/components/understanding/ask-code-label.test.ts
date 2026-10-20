import { describe, expect, it, vi } from 'vitest';

const codex = vi.hoisted(() => ({ models: [] as { slug: string; isDefault?: true }[] }));
vi.mock('../../lib/codex-models', () => ({
  loadCodexModels: vi.fn(),
  codexModels: () => codex.models,
}));

import { askCodeLabel } from './ask-code-label';

describe('askCodeLabel', () => {
  it('names the model Codex runs when none is chosen', () => {
    codex.models = [{ slug: 'gpt-6-sol' }, { slug: 'gpt-6-astra', isDefault: true }];
    expect(askCodeLabel('codex', '')).toBe('Codex · gpt-6-astra');
    expect(askCodeLabel('codex', 'gpt-6-sol')).toBe('Codex · gpt-6-sol');
  });

  it('names only the provider while Codex lists no models', () => {
    codex.models = [];
    expect(askCodeLabel('codex', '')).toBe('Codex');
  });
});
