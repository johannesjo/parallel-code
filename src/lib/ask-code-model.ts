import {
  ASK_CODE_CLAUDE_EFFORT,
  type AskCodeProvider,
} from '../../electron/shared/ask-code-models';
import { codexModels, loadCodexModels } from './codex-models';

/**
 * The model a request runs: the one chosen, else for Codex the one its CLI
 * runs by default, which requests then name explicitly so the app always
 * shows a real model. Empty only while Codex lists none; the CLI chooses then.
 */
export function modelToRun(provider: AskCodeProvider, chosen: string): string {
  if (chosen || provider !== 'codex') return chosen;
  // The name is needed before any menu opens; the list loads once per session.
  loadCodexModels();
  return codexModels().find((model) => model.isDefault)?.slug ?? '';
}

/**
 * The reasoning level a request runs at: the one chosen, else the level the
 * request then names, so the app shows a real level rather than "Default".
 * Empty for MiniMax, and for a Codex model whose cache names no level.
 */
export function effortToRun(provider: AskCodeProvider, model: string, chosen: string): string {
  if (chosen || provider === 'minimax') return chosen;
  if (provider === 'claude') return ASK_CODE_CLAUDE_EFFORT;
  return codexModels().find((choice) => choice.slug === model)?.defaultEffort ?? '';
}
