/**
 * Shared JSON reader for model responses that must contain exactly one object.
 * Used by change tours and understanding tours.
 */

const MALFORMED = 'The provider returned malformed tour JSON. Please retry the tour.';
const INCOMPLETE = 'The provider returned incomplete tour JSON. Please retry the tour.';
const AMBIGUOUS = 'The provider did not return a single complete tour. Please retry the tour.';

/**
 * Whether a fragment is JSON the caller asked for rather than prose or a code
 * snippet: a `{` followed by a quoted key, or the required key when one is given.
 */
function looksLikeJsonObject(fragment: string, requiredKey?: string): boolean {
  if (requiredKey) return new RegExp(`"${requiredKey}"\\s*:`).test(fragment);
  return /^\{\s*"/.test(fragment);
}

/** Index just past the object starting at `start`, or -1 when it never closes. */
function findObjectEnd(text: string, start: number): number {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    if (depth === 0) return index + 1;
  }
  return -1;
}

function hasRequiredKey(candidate: object, requiredKey?: string): boolean {
  return requiredKey === undefined || requiredKey in candidate;
}

function collectObjects(text: string, requiredKey?: string): unknown[] {
  const candidates: unknown[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '{') continue;
    const end = findObjectEnd(text, index);
    if (end < 0) {
      // Markdown and prose also contain braces. Only an unfinished JSON object
      // means the provider was cut off; anything else is surrounding text.
      if (looksLikeJsonObject(text.slice(index), requiredKey)) throw new Error(INCOMPLETE);
      break;
    }
    const fragment = text.slice(index, end);
    try {
      const candidate: unknown = JSON.parse(fragment);
      if (candidate && typeof candidate === 'object' && hasRequiredKey(candidate, requiredKey))
        candidates.push(candidate);
    } catch {
      if (looksLikeJsonObject(fragment, requiredKey)) throw new Error(MALFORMED);
    }
    index = end - 1;
  }
  return candidates;
}

/**
 * Accept prose/code fences around one JSON object, without repairing malformed
 * JSON or accidentally accepting only the first of several generated objects.
 *
 * @param requiredKey when given, only objects carrying this key count, so an
 * unrelated JSON object in the provider's commentary is ignored rather than
 * making the response ambiguous.
 */
export function readSingleJsonObject(text: string, requiredKey?: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Providers occasionally wrap otherwise valid JSON in commentary.
  }
  const candidates = collectObjects(trimmed, requiredKey);
  if (candidates.length !== 1) throw new Error(AMBIGUOUS);
  return candidates[0];
}
