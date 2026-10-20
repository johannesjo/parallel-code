import fs from 'fs';
import os from 'os';
import path from 'path';
import type { StatusLineSetting } from './claude-settings.js';

function isStatusLine(value: unknown): value is StatusLineSetting {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  return (
    raw.type === 'command' &&
    typeof raw.command === 'string' &&
    raw.command.trim() !== '' &&
    (raw.padding === undefined || typeof raw.padding === 'number') &&
    (raw.refreshInterval === undefined || typeof raw.refreshInterval === 'number') &&
    (raw.hideVimModeIndicator === undefined || typeof raw.hideVimModeIndicator === 'boolean')
  );
}

/** The tier's `statusLine`: null when it sets none, undefined when the file cannot be trusted to say. */
function tierStatusLine(file: string): StatusLineSetting | null | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const value = (parsed as { statusLine?: unknown }).statusLine;
  if (value === undefined || value === null) return null;
  return isStatusLine(value) ? { ...value } : undefined;
}

/**
 * The status line Claude Code would run in `cwd` without the app's `--settings`:
 * the highest of the user, project and local tiers that sets one. Null when none
 * does. Undefined when a tier cannot be read or holds a `statusLine` this cannot
 * pass on faithfully; the caller then registers no status line at all, so the
 * user's own keeps working and only the usage meter goes without.
 *
 * Managed settings are not read: a managed `statusLine` outranks `--settings`,
 * so the CLI keeps running it either way.
 */
export function readUserStatusLine(
  cwd: string,
  env: Record<string, string | undefined>,
): StatusLineSetting | null | undefined {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const tiers = [
    path.join(configDir, 'settings.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
  ];
  let resolved: StatusLineSetting | null = null;
  for (const file of tiers) {
    const tier = tierStatusLine(file);
    if (tier === undefined) return undefined;
    if (tier) resolved = tier;
  }
  return resolved;
}
