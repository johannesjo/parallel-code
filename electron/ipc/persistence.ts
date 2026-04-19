import { app } from 'electron';
import fs from 'fs';
import path from 'path';

function getStateDir(): string {
  let dir = app.getPath('userData');
  // Use separate dir for dev mode
  if (!app.isPackaged) {
    const base = path.basename(dir);
    dir = path.join(path.dirname(dir), `${base}-dev`);
  }
  return dir;
}

function getStatePath(): string {
  return path.join(getStateDir(), 'state.json');
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
