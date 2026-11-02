/** What a capture run's stream told so far: the latest step, and its final answer. */
export interface ScreensStream {
  /** Feeds raw stdout; calls `onStep` for each new step the model takes. */
  feed: (chunk: string) => void;
  /** The final answer, or the error the CLI reported; undefined if the run ended early. */
  outcome: () => { answer: string } | { error: string } | undefined;
}

const MAX_STEP_CHARS = 80;
/** Longer lines are tool output, never the answer; dropping them bounds memory. */
const MAX_LINE_CHARS = 1_000_000;

function parseLine(line: string): Record<string, unknown> | undefined {
  if (!line.trim().startsWith('{')) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    // Not every line is an event; stray output is ignored.
    return undefined;
  }
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** A tool call as a short step: Claude's own description of a shell command, else its kind. */
export function describeStep(name: string, input: unknown): string {
  const fields = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (name === 'Bash') {
    // Never the raw command: it can carry secrets such as `API_KEY=… npm run dev`.
    const text = asString(fields.description);
    if (text) return text.length > MAX_STEP_CHARS ? `${text.slice(0, MAX_STEP_CHARS - 1)}…` : text;
    return 'Running a command';
  }
  if (name === 'Read' && /\.png$/i.test(asString(fields.file_path) ?? '')) {
    return 'Checking a screenshot';
  }
  return ['Read', 'Glob', 'Grep'].includes(name) ? 'Reading the code' : name;
}

function stepsOf(event: Record<string, unknown>): string[] {
  const message = event.message as { content?: unknown } | undefined;
  const content = Array.isArray(message?.content) ? message.content : [];
  return (content as Record<string, unknown>[])
    .filter((block) => block.type === 'tool_use')
    .map((block) => describeStep(asString(block.name) ?? 'Tool', block.input));
}

/** A failed result's message; newer CLIs name only the failure class in `subtype`. */
function errorOf(event: Record<string, unknown>): string {
  const errors = Array.isArray(event.errors) ? event.errors.map(asString) : [];
  const subtype = asString(event.subtype)
    ?.replace(/^error_?/, '')
    .replace(/_/g, ' ');
  return (
    asString(event.result) ??
    asString(event.error) ??
    errors.find(Boolean) ??
    (subtype ? `Claude stopped: ${subtype}.` : 'Claude reported an error.')
  );
}

/** Parser for `claude -p --output-format stream-json --verbose`. */
export function createScreensStream(onStep: (step: string) => void): ScreensStream {
  let tail = '';
  /** True while dropping the rest of an oversized line, up to its newline. */
  let skipping = false;
  let outcome: { answer: string } | { error: string } | undefined;
  const handle = (line: string) => {
    const event = parseLine(line);
    if (event?.type === 'assistant') stepsOf(event).forEach(onStep);
    if (event?.type !== 'result') return;
    outcome =
      event.is_error === true
        ? { error: errorOf(event) }
        : { answer: asString(event.result) ?? '' };
  };
  return {
    feed: (chunk) => {
      let text = chunk;
      if (skipping) {
        const end = text.indexOf('\n');
        if (end < 0) return;
        skipping = false;
        text = text.slice(end + 1);
      }
      const lines = (tail + text).split('\n');
      tail = lines.pop() ?? '';
      if (tail.length > MAX_LINE_CHARS) {
        tail = '';
        skipping = true;
      }
      lines.forEach(handle);
    },
    outcome: () => {
      if (tail) handle(tail);
      tail = '';
      return outcome;
    },
  };
}
