/**
 * Check suites: what the app observed about a task's change, its scan
 * and check runs. Renderer-safe: no Node or Electron imports.
 */
import type { VerificationRun } from '../ipc/shared-types.js';

export type CheckKind = 'unit' | 'e2e' | 'static' | 'custom';

/** A repository file read so a model can suggest a project's checks. */
export interface CheckSource {
  path: string;
  text: string;
}

/** A command the app runs in the task worktree. Lives in app state, never in a
 *  repo file, for the same reason as `Project.verifyCommand`. */
export interface ProjectCheck {
  id: string;
  name: string;
  kind: CheckKind;
  command: string;
  /** Whether a review's check picker starts with this check ticked; only until the
   *  project saves its own pick (`Project.reviewChecks`). Never starts a run by itself. */
  run: 'auto' | 'on-demand';
}

/** Id of the implicit check backed by `Project.verifyCommand`. */
export const VERIFY_CHECK_ID = 'verify';
export const CHECK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type CheckModelProvider = 'claude' | 'codex';

/** A model choice for reviews and check suggestions. */
export interface CheckModelSettings {
  provider: CheckModelProvider;
  model?: string;
  effort?: string;
}

export interface ScanFlag {
  id: string;
  rule: string;
  file: string;
  detail: string;
}

export type ScanFileRole = 'test' | 'source' | 'execution-surface' | 'other';

export interface ScanFileChange {
  path: string;
  oldPath?: string;
  status: 'A' | 'M' | 'D' | 'R';
  role: ScanFileRole;
}

/** Static facts about the committed change; nothing in it executes repo code. */
export interface ChangeScan {
  headSha: string;
  baseSha: string;
  /** Uncommitted changes existed when the scan ran. */
  dirty: boolean;
  files: ScanFileChange[];
  flags: ScanFlag[];
  /** Lists were cut to their caps. */
  truncated?: boolean;
}

export interface SuiteCheckRun extends VerificationRun {
  checkId: string;
  name: string;
  kind: CheckKind;
  /** Taken over from the task's manual verify run on the same commit. */
  reused?: boolean;
}

export type CheckSkipReason = 'on-demand' | 'docker' | 'execution-surface' | 'dirty' | 'incomplete';

export interface SkippedCheck {
  checkId: string;
  name: string;
  kind: CheckKind;
  reason: CheckSkipReason;
}

export interface CheckSuite {
  id: string;
  /** True while the scan or checks are in flight. */
  assembling: boolean;
  scan: ChangeScan;
  checks: SuiteCheckRun[];
  skipped: SkippedCheck[];
}

/** A high-effort review of a whole change can take a while. */
export const MODEL_REQUEST_TIMEOUT_MS = 10 * 60_000;
/** Character budget for a structured model prompt, such as a review's diff. */
export const MODEL_REQUEST_PROMPT_LIMIT = 300_000;

export const CHECK_SUITE_LIMITS = {
  /** Per check output kept on a persisted package. */
  persistedTailChars: 8 * 1024,
  maxFlags: 50,
  maxFiles: 300,
} as const;
