import path from 'path';
import { fileURLToPath } from 'url';

/**
 * The bundled `mcp-server.cjs` on the host. Packaged builds run it from
 * `app.asar.unpacked`, because a child process cannot execute from inside the archive.
 * Keep this file in `electron/ipc/`: the path is relative to its build output.
 */
export function hostMcpServerPath(): string {
  return path
    .join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp-server.cjs')
    .replace('/app.asar/', '/app.asar.unpacked/');
}

/** Path where `mcp-server.cjs` is copied inside the Docker-mounted worktree. */
export function getDockerMcpServerDestPath(
  worktreePath: string | undefined,
  projectRoot: string,
): string {
  return path.join(worktreePath ?? projectRoot, '.parallel-code', 'mcp-server.cjs');
}
