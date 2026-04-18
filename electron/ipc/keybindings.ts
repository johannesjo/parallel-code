import fs from 'fs';
import path from 'path';

const FILENAME = 'keybindings.json';

/**
 * Persisted keybinding config.
 * - `overridesByPreset` is the current shape (per-preset user overrides)
 * - `userOverrides` is the legacy flat shape (still accepted on load)
 */
export interface PersistedKeybindings {
  preset: string;
  overridesByPreset?: Record<string, Record<string, unknown>>;
  /** @deprecated use overridesByPreset. Still read for backward compat. */
  userOverrides?: Record<string, unknown>;
}

const DEFAULT_CONFIG: PersistedKeybindings = {
  preset: 'default',
  overridesByPreset: {},
};

function isValidShape(parsed: unknown): parsed is PersistedKeybindings {
  if (!parsed || typeof parsed !== 'object') return false;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.preset !== 'string') return false;
  if (obj.overridesByPreset !== undefined && typeof obj.overridesByPreset !== 'object') {
    return false;
  }
  if (obj.userOverrides !== undefined && typeof obj.userOverrides !== 'object') return false;
  return true;
}

export function loadKeybindings(dir: string): PersistedKeybindings {
  const filePath = path.join(dir, FILENAME);
  const bakPath = filePath + '.bak';

  for (const candidate of [filePath, bakPath]) {
    try {
      if (fs.existsSync(candidate)) {
        const content = fs.readFileSync(candidate, 'utf8');
        if (content.trim()) {
          const parsed: unknown = JSON.parse(content);
          if (isValidShape(parsed)) {
            return parsed;
          }
        }
      }
    } catch {
      // Try next candidate
    }
  }

  return { ...DEFAULT_CONFIG };
}

export function saveKeybindings(dir: string, json: string): void {
  const filePath = path.join(dir, FILENAME);
  fs.mkdirSync(dir, { recursive: true });

  // Validate JSON structure before writing
  const parsed: unknown = JSON.parse(json);
  if (!isValidShape(parsed)) {
    throw new Error('Invalid keybinding config shape');
  }

  const tmpPath = filePath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, json, 'utf8');

    if (fs.existsSync(filePath)) {
      try {
        fs.copyFileSync(filePath, filePath + '.bak');
      } catch {
        /* ignore */
      }
    }

    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}
