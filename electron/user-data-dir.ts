import { app } from 'electron';
import path from 'path';

/**
 * Per-instance data directory, given Electron's `userData` path.
 *
 * A dev run gets its own `<name>-dev` directory so `npm run dev` does not read
 * or write the installed build's data. Pure and parameterised so the rule can be
 * tested without an Electron runtime, and so there is exactly one copy of it.
 */
export function resolveUserDataDir(userDataPath: string, isPackaged: boolean): string {
  if (isPackaged) return userDataPath;
  const base = path.basename(userDataPath);
  return path.join(path.dirname(userDataPath), `${base}-dev`);
}

/**
 * The per-instance data directory for this process.
 *
 * Every file the app keeps under `userData` goes here rather than under
 * `app.getPath('userData')` directly. The suffix is what keeps a dev run and an
 * installed build from writing over each other, so a caller that reaches past
 * this helper silently opts one of its files out of that separation.
 */
export function getUserDataDir(): string {
  return resolveUserDataDir(app.getPath('userData'), app.isPackaged);
}
