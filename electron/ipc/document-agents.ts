/**
 * Headless launches for document proposals: how each supported CLI is
 * started in print mode, and how its output is turned into a readable log,
 * a final message and a session id.
 */
import { documentAgentSupport } from '../shared/document-agents.js';

export interface HeadlessLaunch {
  command: string;
  args: string[];
}

export interface HeadlessLaunchOptions {
  agentId: string;
  command: string;
  prompt: string;
  /** Session to resume; ignored when the agent cannot resume. */
  sessionId?: string;
  /** Session id to assign to a fresh Claude run so it can be resumed later. */
  newSessionId: string;
}

export interface HeadlessOutcome {
  resultText: string;
  sessionId?: string;
  /** Provider-reported error, when the stream carried one. */
  error?: string;
}

/** Incremental parser over a CLI's stdout. */
export interface HeadlessOutputParser {
  /** Feed raw stdout; returns human-readable log lines to forward. */
  feed(chunk: string): string[];
  /** Flush and return the final outcome once the process exited. */
  finish(): HeadlessOutcome;
}

/** Tools a document proposal may use: read and edit files, nothing that runs code. */
export const CLAUDE_DOCUMENT_TOOLS = 'Read,Edit,Write,Glob,Grep';

export function buildHeadlessLaunch(opts: HeadlessLaunchOptions): HeadlessLaunch {
  const support = documentAgentSupport(opts.agentId);
  if (!support.headless) {
    throw new Error(`Agent "${opts.agentId}" has no headless mode for document runs.`);
  }
  const resume = support.resume && opts.sessionId ? opts.sessionId : undefined;

  switch (opts.agentId) {
    case 'claude-code': {
      const args = [
        '-p',
        opts.prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'acceptEdits',
        '--tools',
        CLAUDE_DOCUMENT_TOOLS,
      ];
      if (resume) args.push('--resume', resume);
      else args.push('--session-id', opts.newSessionId);
      return { command: opts.command, args };
    }
    case 'codex': {
      const args = ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check'];
      if (resume) args.push('resume', resume, opts.prompt);
      else args.push(opts.prompt);
      return { command: opts.command, args };
    }
    case 'gemini':
      return {
        command: opts.command,
        args: ['-p', opts.prompt, '--output-format', 'json', '--approval-mode', 'auto_edit'],
      };
    default:
      throw new Error(`Agent "${opts.agentId}" has no headless mode for document runs.`);
  }
}

function tryParseJson(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function describeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return name;
  const obj = input as Record<string, unknown>;
  const target =
    asString(obj.file_path) ?? asString(obj.path) ?? asString(obj.pattern) ?? asString(obj.command);
  return target ? `${name} ${target}` : name;
}

/** Splits a stream into complete lines, keeping a partial tail between feeds. */
class LineBuffer {
  private tail = '';
  push(chunk: string): string[] {
    const data = this.tail + chunk;
    const lines = data.split('\n');
    this.tail = lines.pop() ?? '';
    return lines;
  }
  flush(): string[] {
    const rest = this.tail;
    this.tail = '';
    return rest.trim() ? [rest] : [];
  }
}

/** Parser for `claude -p --output-format stream-json --verbose`. */
class ClaudeStreamParser implements HeadlessOutputParser {
  private readonly lines = new LineBuffer();
  private sessionId?: string;
  private result?: string;
  private error?: string;
  private lastAssistantText = '';

  feed(chunk: string): string[] {
    return this.lines.push(chunk).flatMap((line) => this.handle(line));
  }

  private handle(line: string): string[] {
    const event = tryParseJson(line);
    if (!event) return line.trim() ? [line] : [];
    const sid = asString(event.session_id);
    if (sid) this.sessionId = sid;

    switch (event.type) {
      case 'system':
        return event.subtype === 'init' ? ['session started'] : [];
      case 'assistant': {
        const message = event.message as { content?: unknown } | undefined;
        const content = Array.isArray(message?.content) ? message.content : [];
        const out: string[] = [];
        for (const block of content as Record<string, unknown>[]) {
          if (block.type === 'text' && typeof block.text === 'string') {
            this.lastAssistantText = block.text;
            out.push(block.text);
          } else if (block.type === 'tool_use') {
            out.push(`→ ${describeToolInput(asString(block.name) ?? 'tool', block.input)}`);
          }
        }
        return out;
      }
      case 'result': {
        const text = asString(event.result);
        if (text) this.result = text;
        if (event.is_error === true) {
          this.error = text ?? asString(event.error) ?? 'agent reported an error';
        }
        return [];
      }
      default:
        return [];
    }
  }

  finish(): HeadlessOutcome {
    const rest = this.lines.flush().flatMap((line) => this.handle(line));
    void rest;
    return {
      resultText: this.result ?? this.lastAssistantText,
      sessionId: this.sessionId,
      error: this.error,
    };
  }
}

/** Parser for `codex exec --json` (JSONL thread events). */
class CodexJsonlParser implements HeadlessOutputParser {
  private readonly lines = new LineBuffer();
  private threadId?: string;
  private lastMessage = '';
  private error?: string;

  feed(chunk: string): string[] {
    return this.lines.push(chunk).flatMap((line) => this.handle(line));
  }

  private handle(line: string): string[] {
    const event = tryParseJson(line);
    if (!event) return line.trim() ? [line] : [];

    switch (event.type) {
      case 'thread.started': {
        const id = asString(event.thread_id);
        if (id) this.threadId = id;
        return ['session started'];
      }
      case 'item.completed': {
        const item = (event.item ?? {}) as Record<string, unknown>;
        switch (item.type) {
          case 'agent_message': {
            const text = asString(item.text) ?? '';
            if (text) this.lastMessage = text;
            return text ? [text] : [];
          }
          case 'file_change': {
            const changes = Array.isArray(item.changes) ? item.changes : [];
            return changes.map((c) => {
              const change = c as Record<string, unknown>;
              return `→ ${asString(change.kind) ?? 'edit'} ${asString(change.path) ?? ''}`.trim();
            });
          }
          case 'command_execution':
            return [`→ ran ${asString(item.command) ?? 'command'}`];
          case 'error':
            this.error = asString(item.message) ?? 'agent reported an error';
            return [`error: ${this.error}`];
          default:
            return [];
        }
      }
      case 'error': {
        this.error = asString(event.message) ?? 'agent reported an error';
        return [`error: ${this.error}`];
      }
      default:
        return [];
    }
  }

  finish(): HeadlessOutcome {
    for (const line of this.lines.flush()) this.handle(line);
    return { resultText: this.lastMessage, sessionId: this.threadId, error: this.error };
  }
}

/** Parser for `gemini -p --output-format json`: a single JSON document with `response`. */
class GeminiJsonParser implements HeadlessOutputParser {
  private raw = '';

  feed(chunk: string): string[] {
    this.raw += chunk;
    return [];
  }

  finish(): HeadlessOutcome {
    const parsed = tryParseJson(this.raw);
    if (parsed) {
      const response = asString(parsed.response);
      const error = parsed.error as Record<string, unknown> | undefined;
      return {
        resultText: response ?? '',
        sessionId: asString(parsed.session_id),
        error: error ? (asString(error.message) ?? 'agent reported an error') : undefined,
      };
    }
    return { resultText: this.raw };
  }
}

/** Plain-text fallback: everything is the final message. */
class PlainTextParser implements HeadlessOutputParser {
  private readonly lines = new LineBuffer();
  private raw = '';

  feed(chunk: string): string[] {
    this.raw += chunk;
    return this.lines.push(chunk).filter((l) => l.trim().length > 0);
  }

  finish(): HeadlessOutcome {
    return { resultText: this.raw };
  }
}

export function createHeadlessParser(agentId: string): HeadlessOutputParser {
  switch (agentId) {
    case 'claude-code':
      return new ClaudeStreamParser();
    case 'codex':
      return new CodexJsonlParser();
    case 'gemini':
      return new GeminiJsonParser();
    default:
      return new PlainTextParser();
  }
}
