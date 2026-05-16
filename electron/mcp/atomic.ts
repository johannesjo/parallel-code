import {
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  fchmodSync,
  renameSync,
  unlinkSync,
  statSync,
} from 'fs';
import { open, rename, unlink, stat } from 'fs/promises';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';

function resolveMode(filePath: string, requested: number | undefined): number | undefined {
  if (requested !== undefined) return requested;
  try {
    return statSync(filePath).mode & 0o777;
  } catch {
    return undefined; // file doesn't exist yet — let the umask apply
  }
}

async function resolveModeAsync(
  filePath: string,
  requested: number | undefined,
): Promise<number | undefined> {
  if (requested !== undefined) return requested;
  try {
    return (await stat(filePath)).mode & 0o777;
  } catch {
    return undefined;
  }
}

function dirFsyncSync(filePath: string): void {
  let fd = -1;
  try {
    fd = openSync(dirname(filePath), 'r');
    fsyncSync(fd);
  } catch {
    // Directory fsync unsupported on some platforms (e.g. Windows, some network mounts).
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

async function dirFsync(filePath: string): Promise<void> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(dirname(filePath), 'r');
    await fh.sync();
  } catch {
    // Directory fsync unsupported on some platforms (e.g. Windows, some network mounts).
  } finally {
    try {
      await fh?.close();
    } catch {
      /* ignore */
    }
  }
}

/** Write `data` to `filePath` atomically: write to a temp file then rename.
 *  A crash between write and rename leaves a stale .tmp file but never a torn target.
 *  Preserves the existing file's mode when no mode is specified.
 *  Uses fchmod after open to set the exact mode, bypassing the process umask. */
export function atomicWriteFileSync(
  filePath: string,
  data: string,
  options?: { mode?: number },
): void {
  const mode = resolveMode(filePath, options?.mode);
  const tmp = join(dirname(filePath), `.parallel-code-atomic-${randomUUID()}.tmp`);
  let fd = -1;
  try {
    fd = openSync(tmp, 'w', mode); // pre-set mode; still subject to umask
    if (mode !== undefined) fchmodSync(fd, mode); // correct umask to get exact bits
    writeFileSync(fd, data); // loops internally — no short-write risk
    fsyncSync(fd);
    closeSync(fd);
    fd = -1;
    renameSync(tmp, filePath);
    dirFsyncSync(filePath);
  } catch (err) {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/** Async version: write `data` to `filePath` atomically via temp file + rename.
 *  Preserves the existing file's mode when no mode is specified.
 *  Uses FileHandle.chmod after open to set the exact mode, bypassing the process umask. */
export async function atomicWriteFile(
  filePath: string,
  data: string,
  options?: { mode?: number },
): Promise<void> {
  const mode = await resolveModeAsync(filePath, options?.mode);
  const tmp = join(dirname(filePath), `.parallel-code-atomic-${randomUUID()}.tmp`);
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(tmp, 'w', mode); // pre-set mode; still subject to umask
    if (mode !== undefined) await fh.chmod(mode); // correct umask to get exact bits
    await fh.writeFile(data);
    await fh.sync();
    await fh.close();
    fh = undefined;
    await rename(tmp, filePath);
    await dirFsync(filePath);
  } catch (err) {
    if (fh) {
      try {
        await fh.close();
      } catch {
        /* ignore */
      }
    }
    try {
      await unlink(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}
