// Shared branch-name validator used by MCP, REST, and IPC paths.
// Conservative subset of git check-ref-format rules — no process spawn.

export function validateBranchName(value: unknown, field = 'branch'): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  if (!value.trim()) throw new Error(`${field} must be a non-empty string`);
  // git check-ref-format --branch rejects HEAD specifically; FETCH_HEAD etc. are accepted.
  if (value === 'HEAD') throw new Error(`${field} must not be "HEAD"`);
  if (value.startsWith('-')) throw new Error(`${field} must not start with "-"`);
  if (value.startsWith('.')) throw new Error(`${field} must not start with "."`);
  if (value.startsWith('/')) throw new Error(`${field} must not start with "/"`);
  if (value.endsWith('/')) throw new Error(`${field} must not end with "/"`);
  if (value.endsWith('.')) throw new Error(`${field} must not end with "."`);
  // Git rejects any path component ending in .lock, not just the full name.
  if (/(?:^|\/)[^/]+\.lock(?:\/|$)/.test(value))
    throw new Error(`${field} must not contain a ".lock" path component`);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f ]/.test(value)) throw new Error(`${field} contains invalid characters`);
  // Reject git check-ref-format illegal characters.
  if (/[`$(){}[\]<>\\'*?!#;|&":^~]/.test(value))
    throw new Error(`${field} contains invalid characters`);
  // Reject sequences illegal per git check-ref-format.
  if (value.includes('..')) throw new Error(`${field} must not contain ".."`);
  if (value.includes('@{')) throw new Error(`${field} must not contain "@{"`);
  if (value.includes('//')) throw new Error(`${field} must not contain "//"`);
  // Reject path components starting with "." (e.g. feature/.hidden).
  if (/(?:^|\/)\./.test(value))
    throw new Error(`${field} must not contain a component starting with "."`);
  return value;
}

/** Validate that a value is a v4 UUID. Throws if invalid. */
export function validateUUID(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new Error(`${field} must be a valid UUID`);
  return value;
}
