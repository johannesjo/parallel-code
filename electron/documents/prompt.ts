import type { DocumentRationale, DocumentScope } from '../ipc/shared-types.js';

/** Largest diff (in characters) handed to a resumed main session. */
const MAX_CATCH_UP_DIFF_CHARS = 20_000;

export interface DocumentPromptInput {
  documentPath: string;
  scope: DocumentScope;
  instruction: string;
  /** Diff of the canonical document since the resumed session last saw it. */
  catchUpDiff?: string;
}

function quoteBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
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
