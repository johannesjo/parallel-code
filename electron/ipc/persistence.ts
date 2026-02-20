import { app } from "electron";
import fs from "fs";
import path from "path";

function getStateDir(): string {
  let dir = app.getPath("userData");
  // Use separate dir for dev mode
  if (!app.isPackaged) {
    const base = path.basename(dir);
    dir = path.join(path.dirname(dir), `${base}-dev`);
  }
  return dir;
}

function getStatePath(): string {
  return path.join(getStateDir(), "state.json");
}

export function saveAppState(json: string): void {
  const statePath = getStatePath();
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });

  // Validate JSON before writing
  JSON.parse(json);

  // Atomic write: write to temp, then rename
  const tmpPath = statePath + ".tmp";
  fs.writeFileSync(tmpPath, json, "utf8");

  // Keep one backup
  if (fs.existsSync(statePath)) {
    const bakPath = statePath.replace(".json", ".json.bak");
    try {
      fs.renameSync(statePath, bakPath);
    } catch { /* ignore */ }
  }

  fs.renameSync(tmpPath, statePath);
}

export function loadAppState(): string | null {
  const statePath = getStatePath();

  if (fs.existsSync(statePath)) {
    const content = fs.readFileSync(statePath, "utf8");
    if (content.trim()) return content;
  }

  const bakPath = statePath.replace(".json", ".json.bak");
  if (fs.existsSync(bakPath)) {
    const content = fs.readFileSync(bakPath, "utf8");
    if (content.trim()) return content;
  }

  return null;
}
