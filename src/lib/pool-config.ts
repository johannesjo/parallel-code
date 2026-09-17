import type { PoolConfig } from '../store/types';

/**
 * Text form of a project's pool configuration.
 *
 * The dialog edits pooled workspaces as plain lists rather than as a repeating
 * row widget: the environments of a pool are typed once and changed rarely,
 * and a textarea someone can paste five paths into beats five pickers. Parsing
 * lives here so the dialog stays presentation and the rules stay testable.
 */

/** One absolute path per line; blank lines and duplicates are dropped. */
export function parseEnvPaths(text: string): string[] {
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const value = line.trim().replace(/\/+$/, '');
    if (value) seen.add(value);
  }
  return [...seen];
}

/** One name per line or comma-separated; blank entries are dropped. */
export function parseNameList(text: string): string[] {
  const seen = new Set<string>();
  for (const entry of text.split(/[\n,]/)) {
    const value = entry.trim();
    if (value) seen.add(value);
  }
  return [...seen];
}

/**
 * `key = number` per line.
 *
 * A malformed line is skipped rather than failing the form: the alternative is
 * refusing to save a whole project's settings over one typo in a field that is
 * optional to begin with.
 */
export function parseNumberMap(text: string): Record<string, number> {
  const map: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.lastIndexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = Number(trimmed.slice(separator + 1).trim());
    if (!key || !Number.isInteger(value) || value <= 0) continue;
    map[key] = value;
  }
  return map;
}

export function formatNumberMap(map: Record<string, number> | undefined): string {
  return Object.entries(map ?? {})
    .map(([key, value]) => `${key} = ${value}`)
    .join('\n');
}

export interface PoolFormValues {
  envPaths: string;
  members: string;
  portBase: string;
  portOffsets: string;
}

/**
 * Build the stored configuration from the form.
 *
 * Returns undefined when no environment is listed, which is what makes
 * clearing the field the way to turn a pooled workspace back into an ordinary
 * project — there is no separate "is a pool" switch to leave inconsistent.
 */
export function poolFromForm(values: PoolFormValues): PoolConfig | undefined {
  const envPaths = parseEnvPaths(values.envPaths);
  if (envPaths.length === 0) return undefined;
  const members = parseNameList(values.members);
  const portBase = parseNumberMap(values.portBase);
  const portOffsets = parseNumberMap(values.portOffsets);
  return {
    envPaths,
    members: members.length > 0 ? members : undefined,
    portBase: Object.keys(portBase).length > 0 ? portBase : undefined,
    portOffsets: Object.keys(portOffsets).length > 0 ? portOffsets : undefined,
  };
}

export function poolToForm(pool: PoolConfig | undefined): PoolFormValues {
  return {
    envPaths: (pool?.envPaths ?? []).join('\n'),
    members: (pool?.members ?? []).join('\n'),
    portBase: formatNumberMap(pool?.portBase),
    portOffsets: formatNumberMap(pool?.portOffsets),
  };
}
