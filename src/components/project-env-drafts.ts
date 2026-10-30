import { isValidEnvKey } from '../../electron/shared/env-vars';

/** One editable `KEY=value` row; the id keeps a row's inputs stable while typing. */
export interface EnvDraft {
  id: string;
  key: string;
  value: string;
}

export function envDraftsFrom(env: Record<string, string> | undefined): EnvDraft[] {
  return Object.entries(env ?? {}).map(([key, value]) => ({
    id: crypto.randomUUID(),
    key,
    value,
  }));
}

/** Rows left fully blank are ignored, so an added-but-unused row never blocks saving. */
function filledDrafts(drafts: EnvDraft[]): EnvDraft[] {
  return drafts.filter((d) => d.key.trim() || d.value);
}

/** Why the rows can't be saved, or '' when they can. Names the key so the user finds the row. */
export function envDraftsError(drafts: EnvDraft[]): string {
  const seen = new Set<string>();
  for (const draft of filledDrafts(drafts)) {
    const key = draft.key.trim();
    if (!key) return 'Every value needs a variable name.';
    if (!isValidEnvKey(key)) {
      return `"${key}" is not a valid name: use letters, digits and _, not starting with a digit.`;
    }
    if (seen.has(key)) return `"${key}" is set more than once.`;
    seen.add(key);
  }
  return '';
}

/** The map `updateProject` stores; undefined when no variables remain. Call
 *  only when `envDraftsError` is empty. */
export function finalizeEnvDrafts(drafts: EnvDraft[]): Record<string, string> | undefined {
  const filled = filledDrafts(drafts);
  if (filled.length === 0) return undefined;
  return Object.fromEntries(filled.map((d) => [d.key.trim(), d.value]));
}
