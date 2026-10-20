import { documentAgentSupport } from '../documents/shared.js';

/** Shared with the renderer so tour help describes the actual requested model. */
export const ASK_CODE_MODELS = { claude: 'sonnet', minimax: 'MiniMax-M3.1-Flash' } as const;

/** Ordinary MiniMax choices; saved legacy/custom API model ids remain valid. */
export const ASK_CODE_MINIMAX_MODELS = ['MiniMax-M3.1-Flash', 'MiniMax-M3'] as const;

/** Which CLI or API answers code questions and generates tours. */
export type AskCodeProvider = 'claude' | 'minimax' | 'codex';

/** Claude CLI model aliases offered for code Q&A and tours. */
export const ASK_CODE_CLAUDE_MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const;

/**
 * Codex model slugs come from the CLI's own cache, so they cannot be a fixed
 * list: this is the shape a slug may have before it becomes a `-m` argument.
 */
export const CODEX_MODEL_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;

/** A Codex model as the CLI's own cache lists it. */
export interface CodexModelChoice {
  slug: string;
  displayName: string;
  /** Reasoning levels the model takes, when the cache lists them. */
  efforts?: string[];
  /** The model the CLI runs when the app names none; requests pass it explicitly. */
  isDefault?: true;
  /** The level the CLI runs this model at when the app names none. */
  defaultEffort?: string;
}

/** Guards a model before it becomes a `--model` or `-m` argument to a CLI. */
export function isAskCodeModel(provider: AskCodeProvider, value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (provider === 'codex') return CODEX_MODEL_PATTERN.test(value);
  // This is a JSON API field, not a CLI argument. Keep explicit saved/custom
  // model ids without putting them in the ordinary model picker.
  if (provider === 'minimax') {
    return value === value.trim() && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value);
  }
  return (ASK_CODE_CLAUDE_MODELS as readonly string[]).includes(value);
}

/** What a provider runs with until a model is picked. */
export function defaultAskCodeModel(provider: AskCodeProvider): string {
  if (provider === 'minimax') return ASK_CODE_MODELS.minimax;
  // Codex slugs are only known once its cache has been read; empty lets the CLI choose.
  return provider === 'codex' ? '' : ASK_CODE_MODELS.claude;
}

/**
 * The env file a code Q&A or tour request runs with. Each provider runs its own
 * CLI, so it needs that agent's credentials: Claude's env file cannot log Codex
 * in. MiniMax is an HTTP call with a stored key and no CLI env at all.
 */
export function askCodeEnvFile(
  provider: AskCodeProvider,
  envFiles: Record<string, string>,
): string | undefined {
  if (provider === 'claude') return envFiles['claude-code'];
  return provider === 'codex' ? envFiles.codex : undefined;
}

/**
 * The level Claude tours, answers and reviewers run at when none is chosen.
 * shortcut: fixed level — the CLI keeps its own default per full model id,
 * which the aliases sent here do not name; read it if the CLI ever reports it.
 */
export const ASK_CODE_CLAUDE_EFFORT = 'medium';

/**
 * Reasoning levels each CLI accepts, mirrored from the document runner so the
 * two never disagree. MiniMax is an HTTP call with no such setting.
 */
export function askCodeEfforts(provider: AskCodeProvider): readonly string[] {
  if (provider === 'claude') return documentAgentSupport('claude-code').efforts;
  return provider === 'codex' ? documentAgentSupport('codex').efforts : [];
}

/** Guards an effort before it becomes a CLI argument. */
export function isAskCodeEffort(provider: AskCodeProvider, value: unknown): value is string {
  return typeof value === 'string' && askCodeEfforts(provider).includes(value);
}
