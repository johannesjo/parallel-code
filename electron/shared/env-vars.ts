/** Names a child process can receive and a shell can export. */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidEnvKey(key: string): boolean {
  return ENV_KEY.test(key);
}

/**
 * Keeps the entries of a persisted or IPC-supplied env map that have a valid
 * key and a string value. Returns undefined when none remain, so a project
 * without variables stores nothing and older saved state loads unchanged.
 */
export function sanitizeEnvVars(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && isValidEnvKey(key)) env[key] = value;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}
