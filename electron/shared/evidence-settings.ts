/**
 * Per-project evidence settings: which checks run and which model writes the
 * test summary and findings. Renderer-safe.
 */
import {
  CHECK_ID_PATTERN,
  VERIFY_CHECK_ID,
  type EvidenceCheckKind,
  type EvidenceModelSettings,
  type ProjectCheck,
} from './evidence.js';

const KINDS: readonly EvidenceCheckKind[] = ['unit', 'e2e', 'static', 'custom'];
const WHEN: readonly EvidenceModelSettings['when'][] = ['off', 'manual', 'handoff', 'risky'];
export const MAX_PROJECT_CHECKS = 10;
const MAX_COMMAND_LENGTH = 4096;
const MAX_GUIDANCE_LENGTH = 4000;

export const DEFAULT_EVIDENCE_MODEL: EvidenceModelSettings = { when: 'off', provider: 'claude' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseCheck(value: unknown): ProjectCheck | undefined {
  if (!isRecord(value)) return undefined;
  const { id, name, kind, command, run } = value;
  if (typeof id !== 'string' || !CHECK_ID_PATTERN.test(id) || id === VERIFY_CHECK_ID)
    return undefined;
  if (typeof name !== 'string' || !name.trim()) return undefined;
  if (typeof command !== 'string' || !command.trim() || command.length > MAX_COMMAND_LENGTH)
    return undefined;
  return {
    id,
    name: name.trim(),
    kind: KINDS.includes(kind as EvidenceCheckKind) ? (kind as EvidenceCheckKind) : 'custom',
    command: command.trim(),
    run: run === 'on-demand' ? 'on-demand' : 'auto',
  };
}

/** Drops malformed and duplicate entries instead of rejecting the whole list,
 *  so one bad saved check never loses the others. */
export function parseProjectChecks(value: unknown): ProjectCheck[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const checks: ProjectCheck[] = [];
  for (const item of value.slice(0, MAX_PROJECT_CHECKS)) {
    const check = parseCheck(item);
    if (!check || seen.has(check.id)) continue;
    seen.add(check.id);
    checks.push(check);
  }
  return checks.length > 0 ? checks : undefined;
}

export function parseEvidenceModelSettings(value: unknown): EvidenceModelSettings | undefined {
  if (!isRecord(value)) return undefined;
  const when = WHEN.includes(value.when as EvidenceModelSettings['when'])
    ? (value.when as EvidenceModelSettings['when'])
    : 'off';
  const text = (field: unknown, max: number) =>
    typeof field === 'string' && field.trim() ? field.trim().slice(0, max) : undefined;
  return {
    when,
    provider: value.provider === 'codex' ? 'codex' : 'claude',
    ...(text(value.model, 64) && { model: text(value.model, 64) }),
    ...(text(value.effort, 16) && { effort: text(value.effort, 16) }),
    ...(text(value.guidance, MAX_GUIDANCE_LENGTH) && {
      guidance: text(value.guidance, MAX_GUIDANCE_LENGTH),
    }),
  };
}

/** The checks evidence runs for a project: the verify command first, then the rest. */
export function effectiveChecks(project: {
  verifyCommand?: string;
  evidenceChecks?: ProjectCheck[];
}): ProjectCheck[] {
  const verify: ProjectCheck[] = project.verifyCommand?.trim()
    ? [
        {
          id: VERIFY_CHECK_ID,
          name: 'Verify',
          kind: 'custom',
          command: project.verifyCommand.trim(),
          run: 'auto',
        },
      ]
    : [];
  return [...verify, ...(project.evidenceChecks ?? [])];
}

/** A readable, unique id for a new check, derived from its name. */
export function checkIdFor(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'check';
  const reserved = new Set([...taken, VERIFY_CHECK_ID]);
  if (!reserved.has(base)) return base;
  for (let n = 2; ; n++) if (!reserved.has(`${base}-${n}`)) return `${base}-${n}`;
}
