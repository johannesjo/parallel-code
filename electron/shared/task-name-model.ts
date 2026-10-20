/** A title is a few words; a slow answer is not worth waiting for. */
export const TASK_NAME_TIMEOUT_MS = 30_000;
/** Only the start of a long prompt is sent: a title needs the gist, not the whole text. */
const TASK_NAME_PROMPT_CHARS = 4_000;
/** Backend budget: the excerpt plus the wrapping tags. */
export const TASK_NAME_PROMPT_LIMIT = TASK_NAME_PROMPT_CHARS + 100;
/** Model-chosen names are capped like user-visible titles, not like prompt excerpts. */
export const MODEL_TASK_NAME_MAX_LENGTH = 60;

/**
 * Cheap models offered for the opt-in naming, keyed by the id settings store.
 * A fixed list rather than every Ask Code model: naming runs on each new task,
 * so only models cheap and fast enough for that are offered.
 */
export const TASK_NAME_MODELS = {
  haiku: { label: 'Claude Haiku (claude CLI)', provider: 'claude', model: 'haiku' },
  // Low reasoning: a title needs no deliberation, and Codex defaults to medium.
  luna: { label: 'GPT-6-Luna (codex CLI)', provider: 'codex', model: 'gpt-6-luna', effort: 'low' },
} as const;

export type TaskNameModelId = keyof typeof TASK_NAME_MODELS;

export const DEFAULT_TASK_NAME_MODEL: TaskNameModelId = 'haiku';

export function isTaskNameModelId(value: unknown): value is TaskNameModelId {
  return typeof value === 'string' && Object.keys(TASK_NAME_MODELS).includes(value);
}

/** A title is a few words; a longer reply is prose, such as a refusal or an explanation. */
const MAX_TITLE_WORDS = 10;
/** Openings of a refusal or an apology, which are short enough to pass the word cap. */
const REFUSAL_PATTERN =
  /^(?:i['’]m|i am|i can['’]t|i cannot|i won['’]t|i['’]d|sorry|unfortunately|as an ai)\b/i;
/** Spaced, attributed or nested variants of the tag; nesting is undone by repeating. */
const TASK_PROMPT_TAG = /<\s*\/?\s*task-prompt\b[^>]*>/gi;

function stripTaskPromptTags(text: string): string {
  let previous: string;
  let result = text;
  do {
    previous = result;
    result = result.replace(TASK_PROMPT_TAG, '');
  } while (result !== previous);
  return result;
}

/** The request body: the prompt excerpt, tagged as data so it cannot redirect the model. */
export function buildTaskNamePrompt(prompt: string): string {
  // A pasted closing tag would end the data early and let the rest read as instructions.
  const excerpt = stripTaskPromptTags(prompt.trim().slice(0, TASK_NAME_PROMPT_CHARS));
  return `<task-prompt>\n${excerpt}\n</task-prompt>`;
}

/**
 * The title in a model reply, or '' when the reply holds none. Models sometimes
 * wrap the answer in quotes or markdown, or add a "Title:" label; those go, as
 * do a lead-in line such as "Here's a title:" and code fences around it.
 */
export function parseModelTaskName(reply: string): string {
  const line = reply
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('```') && !/:$/.test(l));
  if (!line || REFUSAL_PATTERN.test(line)) return '';
  const name = line
    .replace(/^(?:title|task name|name)\s*:\s*/i, '')
    .replace(/^[`*_"'“‘#\s]+|[`*_"'”’.!?\s]+$/g, '')
    .trim();
  if (name.split(/\s+/).length > MAX_TITLE_WORDS) return '';
  if (name.length <= MODEL_TASK_NAME_MAX_LENGTH) return name;
  return name.slice(0, MODEL_TASK_NAME_MAX_LENGTH).replace(/\s+\S*$/, '');
}
