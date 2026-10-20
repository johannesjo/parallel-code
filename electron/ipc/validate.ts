/** Runtime type assertion helpers for IPC handler args. */
import os from 'os';
import path from 'path';

/** Reject paths that are non-absolute or attempt directory traversal. */
export function validatePath(p: unknown, label: string): void {
  if (typeof p !== 'string') throw new Error(`${label} must be a string`);
  if (!path.isAbsolute(p)) throw new Error(`${label} must be absolute`);
  if (p.includes('..')) throw new Error(`${label} must not contain ".."`);
}

/**
 * Terminal links pass ~/ paths through unexpanded; only main knows the home directory.
 * Concatenates rather than path.join so a "~/../" path still fails validatePath's ".." check.
 */
export function expandHome(p: string): string {
  return p.startsWith('~/') ? os.homedir() + p.slice(1) : p;
}

export function assertString(val: unknown, label: string): asserts val is string {
  if (typeof val !== 'string') throw new Error(`${label} must be a string`);
}

export function assertInt(val: unknown, label: string): asserts val is number {
  if (typeof val !== 'number' || !Number.isInteger(val))
    throw new Error(`${label} must be an integer`);
}

export function assertBoolean(val: unknown, label: string): asserts val is boolean {
  if (typeof val !== 'boolean') throw new Error(`${label} must be a boolean`);
}

export function assertStringArray(val: unknown, label: string): asserts val is string[] {
  if (!Array.isArray(val) || !val.every((v) => typeof v === 'string'))
    throw new Error(`${label} must be a string array`);
}

export function assertOptionalString(
  val: unknown,
  label: string,
): asserts val is string | undefined {
  if (val !== undefined && typeof val !== 'string')
    throw new Error(`${label} must be a string or undefined`);
}

export function assertOptionalBoolean(
  val: unknown,
  label: string,
): asserts val is boolean | undefined {
  if (val !== undefined && typeof val !== 'boolean')
    throw new Error(`${label} must be a boolean or undefined`);
}
