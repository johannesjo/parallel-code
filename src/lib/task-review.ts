import type { CheckModelSettings } from '../../electron/shared/checks';
import {
  CONFIDENCE_LIMITS,
  parseConfidencePayload,
  type ConfidencePayload,
} from '../../electron/shared/task-confidence';
import { repoContent } from './repo-content';
import { withReviewNotes, type ReviewDismissal } from './review-summary';
import { fencePrompts, prepareDiffForBrief } from './task-brief';
import { readSingleJsonObject } from './tour-json';

/**
 * The review that rates a task's work: a separate model call that reads what
 * the user asked for, the branch diff and the results of the checks it ran,
 * never the task agent's own session, so the agent does not grade itself. It
 * can read the repository to trace callers and tests outside the diff. It returns the same rating an agent can
 * publish with `confidence_publish`.
 */

/** Which model reviews: provider, model and reasoning effort. */
export type ReviewModelSettings = Pick<CheckModelSettings, 'provider' | 'model' | 'effort'>;

/**
 * A review must read callers and tests before it reports; at the Q&A default
 * level Claude often skips those reads and reports guesses from the diff alone.
 */
const REVIEW_CLAUDE_EFFORT = 'high';

/** A review reads a whole diff against every request, so it runs on a strong model. */
export const DEFAULT_REVIEW_MODEL: ReviewModelSettings = { provider: 'claude', model: 'opus' };

/**
 * The level a review runs at: the one chosen, else the review's own for Claude.
 * Applied where a review runs and where its level is shown, not on save, so a
 * later default reaches every user and calls that borrow the reviewer model
 * (suggesting checks) keep the Q&A default.
 */
export function withReviewEffort(model: ReviewModelSettings): ReviewModelSettings {
  return model.provider === 'claude' && !model.effort
    ? { ...model, effort: REVIEW_CLAUDE_EFFORT }
    : model;
}

const REVIEW_LIMITS = {
  /** Every request matters to a review, unlike a brief that only needs the latest. */
  promptsChars: 40_000,
  /** Within the review purpose's 300k budget, leaving room for prompts and notes. */
  diffChars: 200_000,
} as const;

/** Restores the persisted review model; anything malformed falls back to the default. */
export function restoreReviewModel(value: unknown): ReviewModelSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_REVIEW_MODEL;
  const record = value as Record<string, unknown>;
  const text = (field: unknown, max: number) =>
    typeof field === 'string' && field.trim() ? field.trim().slice(0, max) : undefined;
  const model = text(record.model, 64);
  const effort = text(record.effort, 16);
  return {
    provider: record.provider === 'codex' ? 'codex' : 'claude',
    ...(model && { model }),
    ...(effort && { effort }),
  };
}

const INSTRUCTIONS = `You review a coding agent's work for the person who decides whether to merge it. You did not write this code.
Judge the branch diff against what the user asked for in their prompts, later corrections included, not against what the agent says it did.
Return one JSON object: {"asked":string,"changes":[{"now":string,"before"?:string,"tested"?:string}],"keyLine"?:{"file":string,"line"?:number,"why":string},"scores":[{"label":string,"score":number,"why":string,"verified":string[]}],"findings":[{"kind":"gap"|"extra"|"risk"|"unverified","axis":"Correct"|"Complete"|"Minimal","text":string,"file"?:string}]}.
- asked: what the user asked for, later corrections included, in one plain sentence of at most 25 words.
- changes: at most ${CONFIDENCE_LIMITS.maxChanges} changes in behaviour someone using the software would notice, most important first; a refactor that changes nothing they see is not one. now: what happens now, as the start of a sentence, e.g. "After sign-in you land where you were going". before: how that differs from before, e.g. "instead of always on /dashboard"; omit it for something new. tested: the kinds of tests in the diff that cover it, e.g. "unit, integration"; omit it when no test does. Return [] when nothing visible changed.
- keyLine: the one changed line the change depends on most, which the person should read first. file: a repository-relative path from the diff. line: its line number in the changed file, from the diff hunk; omit it when unsure. why: at most 20 words. Omit keyLine when no line stands out.
- scores: exactly three, labelled "Correct", "Complete" and "Minimal", each from 0 to 100. Correct: the change works as intended, judged from the code. Complete: every request is handled, including the cases it implies. Minimal: nothing was changed that the requests did not need. why: one line of at most 25 words naming what keeps the score from being higher. verified: at most ${CONFIDENCE_LIMITS.maxVerified} things you checked yourself that back the score, each at most 15 words, e.g. "read both callers of parseNext"; count a check result only when it is listed under Checks below, and leave out anything you only assumed.
- findings: at most ${CONFIDENCE_LIMITS.maxFindings}, only what the person should act on, most important first. "gap": something asked for that is missing or wrong. "extra": a change nobody asked for. "risk": something likely to break, such as an unhandled case or untested behaviour. "unverified": a doubt you could not confirm by reading the code, such as behaviour only reachable at runtime; name what would settle it. axis: the score it lowers most. text: one short sentence of at most 25 words that names the concrete function, setting or behaviour, never a vague caveat such as "coverage may be incomplete". file: a repository-relative path from the diff that the finding is about; omit it when unsure, never invent one. Return [] when there is nothing.
You can read the repository with read-only tools. Report a gap or a risk only once you have read the code that shows it, outside the diff too, such as the callers of a changed function and the tests of a changed file. A doubt you did not confirm that way is "unverified", never a gap or a risk; something you could settle by reading a file is not a finding until you read it.
Do not run tests, builds or the app yourself; the checks listed below ran on this code, so take their results as fact, and a failed one lowers Correct. Passing checks do not prove the new behaviour is tested, so ask what could still be wrong with every check green: behaviour no test covers, or a test that still asserts the old behaviour. The agent's word is not evidence.
Before you score, make the strongest case that each score is wrong. Every point taken off a score must come from a finding on that axis; with no such finding, the score is 100.
The diff opens with a list of every changed file and its added and removed lines. Lockfiles are left out and long files are cut short; do not report a gap only because a file was cut.`;

export interface TaskReviewPromptInput {
  taskName: string;
  /** Every prompt the user sent the task, oldest first. */
  prompts: readonly string[];
  /** Undefined when the diff could not be read, which is not the same as no changes. */
  rawDiff: string | undefined;
  /** Items the user already set aside, so the review leaves them out. */
  dismissed: ReviewDismissal[];
  /** The user's own review guidance from Settings, if any. */
  guidance?: string;
  /** Checks this review ran on the code, with how each ended. */
  checks?: readonly ReviewCheckResult[];
}

/** A check the review ran: its name and how it ended, e.g. "passed" or "skipped: dirty". */
export interface ReviewCheckResult {
  name: string;
  result: string;
}

export function buildTaskReviewPrompt(input: TaskReviewPromptInput): string {
  const guidance = input.guidance?.trim();
  const head = guidance
    ? `${INSTRUCTIONS}\n\nThe user's guidance for reviews:\n${guidance}`
    : INSTRUCTIONS;
  const prompts = input.prompts.length
    ? fencePrompts(input.prompts, REVIEW_LIMITS.promptsChars)
    : '(none recorded; judge by the task name)';
  const diff =
    input.rawDiff === undefined
      ? '(the diff could not be read; say so in a risk instead of guessing)'
      : repoContent(
          input.rawDiff.trim()
            ? prepareDiffForBrief(input.rawDiff, REVIEW_LIMITS.diffChars)
            : '(no changes)',
        );
  const checks = input.checks?.length
    ? input.checks.map(({ name, result }) => `- ${name}: ${result}`).join('\n')
    : '(none ran)';
  return [
    withReviewNotes(head, input.dismissed),
    `## Task name\n${repoContent(input.taskName)}`,
    `## Checks run on this code\n${repoContent(checks)}`,
    `## What the user asked for, oldest first\n${prompts}`,
    `## Branch diff against its base\n${diff}`,
  ].join('\n\n');
}

function clip(value: unknown, max: number): unknown {
  return typeof value === 'string' ? value.trim().slice(0, max) : value;
}

/** A key line the model got slightly wrong is left out rather than failing the review. */
function keyLineOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.file !== 'string' || typeof record.why !== 'string') return undefined;
  const line = record.line;
  return {
    file: clip(record.file, CONFIDENCE_LIMITS.file),
    why: clip(record.why, CONFIDENCE_LIMITS.why),
    ...(typeof line === 'number' && Number.isInteger(line) && line > 0 && { line }),
  };
}

/** A long reason or one finding too many should not throw away a whole review. */
function fitToLimits(data: Record<string, unknown>): Record<string, unknown> {
  const items = (value: unknown, max: number) =>
    (Array.isArray(value) ? value : [])
      .slice(0, max)
      .map((item: unknown) =>
        item && typeof item === 'object' ? (item as Record<string, unknown>) : {},
      );
  return {
    scores: items(data.scores, CONFIDENCE_LIMITS.maxScores).map((score) => ({
      ...score,
      label: clip(score.label, CONFIDENCE_LIMITS.label),
      why: clip(score.why, CONFIDENCE_LIMITS.why),
      verified: Array.isArray(score.verified)
        ? score.verified
            .filter((entry: unknown): entry is string => typeof entry === 'string')
            .slice(0, CONFIDENCE_LIMITS.maxVerified)
            .map((entry) => clip(entry, CONFIDENCE_LIMITS.verified))
        : undefined,
    })),
    findings: items(data.findings, CONFIDENCE_LIMITS.maxFindings).map((finding) => ({
      ...finding,
      text: clip(finding.text, CONFIDENCE_LIMITS.findingText),
      file: clip(finding.file, CONFIDENCE_LIMITS.file),
      // A stray axis only loses the tag, not the review.
      axis:
        typeof finding.axis === 'string' ? clip(finding.axis, CONFIDENCE_LIMITS.label) : undefined,
    })),
    asked: clip(data.asked, CONFIDENCE_LIMITS.asked),
    changes: items(data.changes, CONFIDENCE_LIMITS.maxChanges).map((change) => ({
      ...change,
      now: clip(change.now, CONFIDENCE_LIMITS.changeText),
      before: clip(change.before, CONFIDENCE_LIMITS.changeText),
      tested: clip(change.tested, CONFIDENCE_LIMITS.tested),
    })),
    keyLine: keyLineOf(data.keyLine),
  };
}

/** Parses the model's answer into a rating; throws when it is not the requested object. */
export function parseTaskReviewResponse(response: string, source: string): ConfidencePayload {
  const data = readSingleJsonObject(response, 'scores');
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('The reviewer returned an invalid rating.');
  return parseConfidencePayload({
    ...fitToLimits(data as Record<string, unknown>),
    source: source.slice(0, CONFIDENCE_LIMITS.source),
  });
}
