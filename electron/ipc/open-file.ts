import { spawn } from 'child_process';
import path from 'path';

/**
 * Editors whose CLI can open a file at a line, keyed by executable name.
 * shortcut: known editors only — a user-defined argument template if others
 * (JetBrains, Vim in a terminal) are wanted.
 */
const GOTO_ARGS: Record<string, (target: string) => string[]> = {
  code: (target) => ['--goto', target],
  'code-insiders': (target) => ['--goto', target],
  codium: (target) => ['--goto', target],
  cursor: (target) => ['--goto', target],
  windsurf: (target) => ['--goto', target],
  zed: (target) => [target],
  subl: (target) => [target],
};

/** Rejects commands that could smuggle shell syntax; spawn runs them without a shell. */
export function validateEditorCommand(editorCommand: unknown): string {
  if (typeof editorCommand !== 'string' || !editorCommand.trim()) {
    throw new Error('editorCommand must be a non-empty string');
  }
  const cmd = editorCommand.trim();
  if (/[;&|`$(){}[\]<>\\'"*?!#~]/.test(cmd)) {
    throw new Error('editorCommand must not contain shell metacharacters');
  }
  return cmd;
}

/**
 * Arguments that open `absolutePath` at `line` in the configured editor, or
 * null when the editor is not one whose line syntax is known.
 */
export function editorGotoArgs(
  editorCommand: string,
  absolutePath: string,
  line: number,
): string[] | null {
  const build = GOTO_ARGS[path.basename(editorCommand)];
  return build ? build(`${absolutePath}:${line}`) : null;
}

/** Launches a GUI program detached from the app; resolves once it has spawned. */
export function spawnDetached(cmd: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Failed to launch "${cmd}": ${err.message}`));
      }
    });
    child.on('spawn', () => {
      if (!settled) {
        settled = true;
        child.unref();
        resolve();
      }
    });
  });
}
