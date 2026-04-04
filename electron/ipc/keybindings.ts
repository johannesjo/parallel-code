import fs from 'fs';
import path from 'path';

const FILENAME = 'keybindings.json';
const DEFAULT_CONFIG = { preset: 'default', userOverrides: {} };

export function loadKeybindings(dir: string): {
  preset: string;
  userOverrides: Record<string, unknown>;
} {
  const filePath = path.join(dir, FILENAME);
  const bakPath = filePath + '.bak';

  for (const candidate of [filePath, bakPath]) {
    try {
      if (fs.existsSync(candidate)) {
        const content = fs.readFileSync(candidate, 'utf8');
        if (content.trim()) {
          const parsed = JSON.parse(content);
          if (parsed && typeof parsed.preset === 'string') {
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

  // Validate JSON before writing
  JSON.parse(json);

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
