/**
 * The execution gate's rule over a parsed diff (no fs, no git): a change to how
 * checks run or what they run against holds automatic checks.
 */
import { CHECK_SUITE_LIMITS, type ScanFlag, type ChangeScan } from '../shared/checks.js';
import { classifyPath } from './change-scan-paths.js';

export { classifyPath } from './change-scan-paths.js';

export interface DiffFileInput {
  path: string;
  oldPath?: string;
  status: 'A' | 'M' | 'D' | 'R';
}

function cap<T>(list: T[], max: number, cut: { value: boolean }): T[] {
  if (list.length <= max) return list;
  cut.value = true;
  return list.slice(0, max);
}

/** Classifies every changed file, flags the execution surface and caps the lists. */
export function analyzeDiff(
  input: DiffFileInput[],
): Pick<ChangeScan, 'files' | 'flags' | 'truncated'> {
  const files = input.map((f) => ({ ...f, role: classifyPath(f.path) }));
  const flags: ScanFlag[] = files
    .filter((f) => f.role === 'execution-surface')
    .map((f) => ({
      id: `execution-surface-changed:${f.path}`,
      rule: 'execution-surface-changed',
      file: f.path,
      detail: 'Changes how checks run or what they run against.',
    }));
  const cut = { value: false };
  return {
    files: cap(files, CHECK_SUITE_LIMITS.maxFiles, cut),
    flags: cap(flags, CHECK_SUITE_LIMITS.maxFlags, cut),
    ...(cut.value && { truncated: true }),
  };
}
