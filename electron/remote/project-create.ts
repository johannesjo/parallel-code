import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { validatePath } from '../ipc/validate.js';

const execFileAsync = promisify(execFile);

const MAX_NAME_LENGTH = 100;

/** A folder name only: no separators, dot-names or control characters. */
export function validateProjectFolderName(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('name must be a string');
  const name = raw.trim();
  if (!name) throw new Error('name must be a non-empty string');
  if (name.length > MAX_NAME_LENGTH)
    throw new Error(`name must be ${MAX_NAME_LENGTH} characters or fewer`);
  // eslint-disable-next-line no-control-regex
  if (/[/\\\x00-\x1f\x7f]/.test(name) || name === '.' || name === '..')
    throw new Error('name must be a plain folder name');
  return name;
}

/**
 * Create `<parentDir>/<name>` as a new git repository for a phone-created
 * project. The parent must already exist and the folder must not, so this
 * never writes into or over something the user already has.
 */
export async function createProjectFolder(parentDir: unknown, rawName: unknown): Promise<string> {
  const name = validateProjectFolderName(rawName);
  if (typeof parentDir !== 'string') throw new Error('parentDir must be a string');
  const parent = parentDir.startsWith('~/')
    ? path.join(os.homedir(), parentDir.slice(2))
    : parentDir === '~'
      ? os.homedir()
      : parentDir;
  validatePath(parent, 'parentDir');
  if (!(await fs.promises.stat(parent).catch(() => null))?.isDirectory())
    throw new Error('parent folder does not exist');

  const projectPath = path.join(parent, name);
  try {
    await fs.promises.mkdir(projectPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error('a folder with that name already exists');
    throw err;
  }
  await execFileAsync('git', ['init'], { cwd: projectPath });
  return projectPath;
}
