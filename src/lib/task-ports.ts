/**
 * Each task owns a block of ports so dev servers in parallel worktrees never
 * fight over the same one. Terminals get the first port as
 * `PARALLEL_CODE_PORT`; the block's other ports are free for extra servers.
 *
 * The range sits below the OS ephemeral ranges (Linux starts at 32768,
 * macOS and Windows at 49152) and above the usual dev-server defaults.
 */
export const PORT_RANGE_START = 20000;
export const PORT_BLOCK_SIZE = 10;
const PORT_RANGE_END = 30000;
export const PORT_ENV_NAME = 'PARALLEL_CODE_PORT';

/** Whether a persisted value is a block start this app could have handed out. */
export function isPortBase(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= PORT_RANGE_START &&
    value + PORT_BLOCK_SIZE <= PORT_RANGE_END &&
    (value - PORT_RANGE_START) % PORT_BLOCK_SIZE === 0
  );
}

/**
 * The lowest block start no other task holds, or undefined when every block
 * is taken.
 * shortcut: only other tasks are avoided, not unrelated programs on the same
 * ports — probe with a test bind in the main process if that ever bites.
 */
export function pickPortBase(taken: Iterable<number>): number | undefined {
  const used = new Set(taken);
  for (let base = PORT_RANGE_START; base + PORT_BLOCK_SIZE <= PORT_RANGE_END; ) {
    if (!used.has(base)) return base;
    base += PORT_BLOCK_SIZE;
  }
  return undefined;
}

/** Replaces `$PARALLEL_CODE_PORT`, `${PARALLEL_CODE_PORT}` and `%PARALLEL_CODE_PORT%`. */
export function expandPortVariable(text: string, portBase: number): string {
  return text.replace(/\$\{PARALLEL_CODE_PORT\}|\$PARALLEL_CODE_PORT\b|%PARALLEL_CODE_PORT%/g, () =>
    String(portBase),
  );
}
