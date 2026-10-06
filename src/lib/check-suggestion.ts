import type { CheckSource, EvidenceCheckKind, ProjectCheck } from '../../electron/shared/evidence';
import { MAX_PROJECT_CHECKS } from '../../electron/shared/evidence-settings';
import { repoContent } from './evidence-review';
import { readSingleJsonObject } from './tour-json';

export interface CheckSuggestion {
  verifyCommand: string;
  checks: Pick<ProjectCheck, 'kind' | 'command' | 'run'>[];
  reason?: string;
}

const KINDS: readonly EvidenceCheckKind[] = ['unit', 'e2e', 'static', 'custom'];
const MAX_COMMAND_LENGTH = 1000;
const MAX_REASON = 400;
const INVALID = 'The model returned an invalid suggestion. Try again.';

const INSTRUCTIONS = `You configure the commands a code review tool runs in a git worktree of this project.
Return one JSON object: {"verifyCommand": string, "checks": [{"kind": "unit"|"e2e"|"static"|"custom", "command": string, "run": "auto"|"on-demand"}], "reason": string}.
- verifyCommand: one shell line that gates every merge, such as typecheck, lint and unit tests chained with &&. It should finish within a few minutes. Use "" when the project has nothing suitable.
- checks: at most ${MAX_PROJECT_CHECKS} extra commands, each reported separately. Do not repeat the verify command. Use "on-demand" for slow suites such as end-to-end tests, "auto" otherwise.
- reason: one or two sentences naming the files the commands come from.
Prefer an aggregate script the project already has (such as "check" or "verify", or what CI runs) over chaining its parts. Only root files are shown; in a monorepo, use root scripts that cover the workspaces.
Only use commands the files below define or clearly imply; never invent scripts. Use the package manager the lockfiles show. Commands must be non-interactive and exit on their own: no watch mode, dev servers, installs, deploys, publishing, or commands that change files (formatters in write mode, fixers).`;

/** The prompt; everything read from the repository is wrapped as data. */
export function buildCheckSuggestionPrompt(sources: CheckSource[]): string {
  const files = sources.map((source) => `## ${source.path}\n${repoContent(source.text)}`);
  return `${INSTRUCTIONS}\n\n${files.join('\n\n')}\n`;
}

function command(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  // The settings fields are single-line inputs.
  if (!trimmed || /[\r\n]/.test(trimmed) || trimmed.length > MAX_COMMAND_LENGTH) return undefined;
  return trimmed;
}

function parseCheck(value: unknown): CheckSuggestion['checks'][number] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { kind, run } = value as Record<string, unknown>;
  const cmd = command((value as Record<string, unknown>).command);
  if (!cmd) return undefined;
  return {
    kind: KINDS.includes(kind as EvidenceCheckKind) ? (kind as EvidenceCheckKind) : 'custom',
    command: cmd,
    run: run === 'on-demand' ? 'on-demand' : 'auto',
  };
}

/** Parses the model's answer; throws when it is not the requested object. */
export function parseCheckSuggestion(response: string): CheckSuggestion {
  let data: unknown;
  try {
    data = readSingleJsonObject(response, 'checks');
  } catch {
    // The reader's own messages talk about tours.
    throw new Error(INVALID);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(INVALID);
  const { verifyCommand, checks, reason } = data as Record<string, unknown>;
  if (!Array.isArray(checks)) throw new Error(INVALID);
  const verify = command(verifyCommand) ?? '';
  const seen = new Set([verify]);
  const parsed = checks
    .map(parseCheck)
    .filter((check): check is CheckSuggestion['checks'][number] => {
      if (!check || seen.has(check.command)) return false;
      seen.add(check.command);
      return true;
    })
    .slice(0, MAX_PROJECT_CHECKS);
  const note = typeof reason === 'string' ? reason.trim().slice(0, MAX_REASON) : '';
  return { verifyCommand: verify, checks: parsed, ...(note && { reason: note }) };
}

type CheckDraft = CheckSuggestion['checks'][number] & { id?: string };

/**
 * The suggested checks, where one the user already has (same command) keeps
 * its id, so evidence recorded for it stays linked.
 */
export function keepCheckIds(
  current: CheckDraft[],
  suggested: CheckSuggestion['checks'],
): CheckDraft[] {
  return suggested.map((check) => {
    const id = current.find((draft) => draft.command.trim() === check.command)?.id;
    return id ? { ...check, id } : check;
  });
}
