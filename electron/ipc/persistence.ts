import fs from 'fs';
import path from 'path';
import { getUserDataDir } from '../user-data-dir.js';

function getStatePath(): string {
  return path.join(getUserDataDir(), 'state.json');
}

export function saveAppState(json: string): void {
  const statePath = getStatePath();
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });

  // Validate JSON before writing
  JSON.parse(json);

  // Atomic write: write to temp, then rename
  const tmpPath = statePath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, json, 'utf8');

    // Keep one backup (copy so statePath is never missing during the operation)
    if (fs.existsSync(statePath)) {
      const bakPath = statePath + '.bak';
      try {
        fs.copyFileSync(statePath, bakPath);
      } catch {
        /* ignore */
      }
    }

    fs.renameSync(tmpPath, statePath);
  } catch (err) {
    // Clean up orphaned temp file on failure
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* temp file may not exist */
    }
    throw err;
  }
}

function getThemesDir(): string {
  return path.join(getUserDataDir(), 'themes');
}

const VALID_THEME_ID = /^[a-zA-Z0-9_-]+$/;

export function loadCustomThemeFiles(): { id: string; css: string }[] {
  const dir = getThemesDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.css'))
    .flatMap((f) => {
      const id = f.slice(0, -4);
      if (!VALID_THEME_ID.test(id)) return [];
      try {
        return [{ id, css: fs.readFileSync(path.join(dir, f), 'utf8') }];
      } catch {
        return [];
      }
    });
}

export function saveCustomThemeFile(id: string, css: string): void {
  const dir = getThemesDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${id}.css`);
  const tmpPath = filePath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, css, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* temp may not exist */
    }
    throw err;
  }
}

export function deleteCustomThemeFile(id: string): void {
  try {
    fs.unlinkSync(path.join(getThemesDir(), `${id}.css`));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

export function loadAppState(): string | null {
  const statePath = getStatePath();
  const bakPath = statePath + '.bak';

  try {
    if (fs.existsSync(statePath)) {
      const content = fs.readFileSync(statePath, 'utf8');
      if (content.trim()) {
        JSON.parse(content); // validate JSON; falls through to backup on invalid
        return content;
      }
    }
  } catch {
    // Primary state file unreadable or invalid JSON — try backup
  }

  try {
    if (fs.existsSync(bakPath)) {
      const content = fs.readFileSync(bakPath, 'utf8');
      if (content.trim()) {
        JSON.parse(content); // validate JSON
        return content;
      }
    }
  } catch {
    // Backup also unreadable or invalid JSON
  }

  return null;
}
