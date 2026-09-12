import type { DocumentRationale, DocumentScope } from './types.js';

/** Largest diff (in characters) handed to a resumed main session. */
const MAX_CATCH_UP_DIFF_CHARS = 20_000;
/*
 * The prompt travels as one argv element, which Linux caps at 128 KiB, so
 * the parts that grow with the proposals are budgeted in bytes: the diffs
 * share one budget across candidates, and everything else is capped so the
 * whole prompt stays under the limit even with six candidates.
 */
/** Bytes of proposal diffs a merging agent sees in total. */
const MERGE_DIFF_BUDGET_BYTES = 60_000;
/** Largest single diff, when few candidates leave room for it. */
const MAX_MERGE_DIFF_BYTES = 30_000;
const MAX_MERGE_NOTE_BYTES = 2_000;
const MAX_MERGE_SUMMARY_BYTES = 500;
const MAX_MERGE_INSTRUCTION_BYTES = 8_000;

/** One proposal a merging agent is asked to fold into its version. */
export interface MergeCandidateInput {
  label: string;
  agentName: string;
  /** The proposal as a diff against the base the agent finds on disk. */
  diff: string;
  /** What the candidate said it did, when it said. */
  summary?: string;
  /** What the reviewer wrote on this candidate in the compare view. */
  note?: string;
}

export interface DocumentPromptInput {
  documentPath: string;
  scope: DocumentScope;
  instruction: string;
  /** Diff of the canonical document since the resumed session last saw it. */
  catchUpDiff?: string;
  /** Original task for the proposal already seeded into the worktree. */
  refinementInstruction?: string;
  /** Proposals to combine; the file on disk is their common base. */
  mergeCandidates?: MergeCandidateInput[];
  /** The task those proposals answered. */
  mergeInstruction?: string;
}

function quoteBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/** Cuts `text` to at most `maxBytes` of UTF-8 on a character boundary, marking the cut. */
export function truncateBytes(text: string, maxBytes: number, marker = '… (truncated)'): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  // A cut inside a multi-byte character decodes to U+FFFD at the end; drop it.
  const head = new TextDecoder().decode(bytes.subarray(0, maxBytes)).replace(/\uFFFD+$/, '');
  return `${head}\n${marker}`;
}

/** One proposal, as the merging agent reads it; `diffBytes` is its share of the budget. */
function describeMergeCandidate(c: MergeCandidateInput, diffBytes: number): string {
  const lines = [`### Candidate ${c.label} (${c.agentName})`];
  if (c.summary?.trim())
    lines.push(`Its own summary: ${truncateBytes(c.summary.trim(), MAX_MERGE_SUMMARY_BYTES)}`);
  if (c.note?.trim())
    lines.push(`The reviewer's note on it: ${truncateBytes(c.note.trim(), MAX_MERGE_NOTE_BYTES)}`);
  lines.push('```diff', truncateBytes(c.diff, diffBytes, '… (diff truncated)'), '```');
  return lines.join('\n');
}

/** Builds the instruction a headless agent receives for one proposal. */
export function buildDocumentPrompt(input: DocumentPromptInput): string {
  const { documentPath, scope, instruction } = input;
  const parts: string[] = [];

  parts.push(
    'You are revising a document in a Parallel Code document workspace. ' +
      'Your working directory is an isolated copy of the project; the file on disk is the current version.',
  );

  if (input.catchUpDiff?.trim()) {
    const diff =
      input.catchUpDiff.length > MAX_CATCH_UP_DIFF_CHARS
        ? input.catchUpDiff.slice(0, MAX_CATCH_UP_DIFF_CHARS) + '\n… (diff truncated)'
        : input.catchUpDiff;
    parts.push(
      'Since your previous turn the canonical document changed. Do not rely on the version you remember; ' +
        're-read the file. The changes were:\n```diff\n' +
        diff +
        '\n```',
    );
  }

  parts.push(`Document: ${documentPath}`);
  if (input.refinementInstruction !== undefined) {
    parts.push(
      'The file contains an unaccepted candidate, not the canonical document. ' +
        'Refine this candidate using the feedback below, preserving its other improvements. ' +
        `The earlier instruction was:\n${input.refinementInstruction.slice(0, 20_000)}`,
    );
  }

  if (input.mergeCandidates && input.mergeCandidates.length > 0) {
    const n = input.mergeCandidates.length;
    const diffBytes = Math.min(MAX_MERGE_DIFF_BYTES, Math.floor(MERGE_DIFF_BUDGET_BYTES / n));
    parts.push(
      [
        `The file on disk is the base version. ${n} candidates proposed changes to it` +
          (input.mergeInstruction !== undefined
            ? `, answering this task:\n${quoteBlock(truncateBytes(input.mergeInstruction, MAX_MERGE_INSTRUCTION_BYTES))}`
            : '.'),
        '',
        'Each candidate is shown below as a diff against that base. Produce one merged version: ' +
          'keep every improvement worth keeping, resolve conflicts by choosing the stronger wording, ' +
          'and drop what none of them would miss. Where the reviewer left a note on a candidate, follow it. ' +
          'Say in the rationale which parts came from which candidate and what you left out.',
        '',
        ...input.mergeCandidates.map((c) => describeMergeCandidate(c, diffBytes)),
      ].join('\n'),
    );
  }

  if (scope.wholeDocument) {
    parts.push('Scope: the whole document.');
  } else {
    const where = scope.heading
      ? `lines ${scope.startLine}-${scope.endLine} (under "${scope.heading}")`
      : `lines ${scope.startLine}-${scope.endLine}`;
    parts.push(`Scope: ${where}. The scoped passage, verbatim:\n${quoteBlock(scope.quote)}`);
  }

  parts.push(`Instruction:\n${instruction.trim()}`);

  parts.push(
    [
      'Rules:',
      `- Edit only ${documentPath}, and only inside the scoped passage. Changes elsewhere are discarded.`,
      '- Do not touch other files, do not run shell commands or git, do not create or delete files.',
      '- Keep the document format, structure conventions and voice unless the instruction says otherwise.',
      '- Do not add markers, identifiers or comments to the document.',
      '- If the instruction cannot be carried out safely, change nothing and explain why.',
      '- End your final message with exactly one fenced ```json block of this shape, and nothing after it:',
      '```json',
      '{"summary": "one line: what changed and why", "changes": ["…"], "assumptions": ["…"], "questions": ["open questions for the reviewer"], "warnings": ["anything the reviewer must know"]}',
      '```',
    ].join('\n'),
  );

  return parts.join('\n\n');
}

/** Rationale entries end up in commit bodies: one line each, no stray newlines. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map(oneLine);
}

function rationaleFromObject(value: unknown): DocumentRationale | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const summary = typeof obj.summary === 'string' ? oneLine(obj.summary) : '';
  const changes = stringList(obj.changes);
  if (!summary && changes.length === 0) return null;
  return {
    summary: summary || changes[0],
    changes,
    assumptions: stringList(obj.assumptions),
    questions: stringList(obj.questions),
    warnings: stringList(obj.warnings),
  };
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Extracts the structured rationale from an agent's final message. Takes the
 * last fenced JSON block; falls back to the whole text as JSON, then to a
 * summary made from the first non-empty line.
 */
export function parseDocumentRationale(text: string): DocumentRationale {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const parsed = rationaleFromObject(tryParse(fences[i][1].trim()));
    if (parsed) return parsed;
  }
  const whole = rationaleFromObject(tryParse(text.trim()));
  if (whole) return whole;

  const prose = text.replace(/```[\s\S]*?```/g, '');
  const firstLine = prose
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return {
    summary: firstLine ? firstLine.slice(0, 200) : 'No rationale returned.',
    changes: [],
    assumptions: [],
    questions: [],
    warnings: firstLine ? [] : ['The agent returned no rationale.'],
  };
}
