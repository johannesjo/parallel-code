export const ASK_CODE_MAX_PROMPT_LENGTH = 50_000;
export const ASK_CODE_MAX_CONCURRENT = 5;
export const ASK_CODE_TIMEOUT_MS = 120_000;
export const ASK_CODE_TIMEOUT_MESSAGE = 'Request timed out after 2 minutes.';
const TOO_MANY_CONCURRENT_MESSAGE = 'Too many concurrent ask-about-code requests';

export interface RequestHandle<T> {
  readonly requestId: string;
  readonly request: T;
  readonly token: symbol;
}

export function assertPromptWithinLimit(prompt: string, max = ASK_CODE_MAX_PROMPT_LENGTH): void {
  if (prompt.length > max) {
    throw new Error(`Prompt too long (${prompt.length} chars, max ${max})`);
  }
}

export function assertCanStart<T>(registry: RequestRegistry<T>, requestId: string): void {
  if (!registry.canStart(requestId)) {
    throw new Error(TOO_MANY_CONCURRENT_MESSAGE);
  }
}

export class RequestRegistry<T> {
  private readonly entries = new Map<
    string,
    {
      handle: RequestHandle<T>;
      timer: ReturnType<typeof setTimeout>;
      onCancel?: (request: T) => void;
    }
  >();

  constructor(
    private readonly opts: {
      maxConcurrent: number;
      timeoutMs: number;
    },
  ) {}

  get size(): number {
    return this.entries.size;
  }

  has(requestId: string): boolean {
    return this.entries.has(requestId);
  }

  canStart(requestId: string): boolean {
    return this.entries.has(requestId) || this.entries.size < this.opts.maxConcurrent;
  }

  start(
    requestId: string,
    request: T,
    onTimeout: (request: T) => void,
    onCancel?: (request: T) => void,
    timeoutMs = this.opts.timeoutMs,
  ): RequestHandle<T> {
    this.cancel(requestId);
    if (this.entries.size >= this.opts.maxConcurrent) {
      throw new Error(TOO_MANY_CONCURRENT_MESSAGE);
    }

    const handle = { requestId, request, token: Symbol(requestId) };
    const timer = setTimeout(() => {
      const entry = this.entries.get(requestId);
      if (!entry || entry.handle.token !== handle.token) return;
      this.entries.delete(requestId);
      onTimeout(entry.handle.request);
      entry.onCancel?.(entry.handle.request);
    }, timeoutMs);

    this.entries.set(requestId, { handle, timer, onCancel });
    return handle;
  }

  finish(handle: RequestHandle<T>): T | undefined {
    const entry = this.entries.get(handle.requestId);
    if (!entry || entry.handle.token !== handle.token) return undefined;
    clearTimeout(entry.timer);
    this.entries.delete(handle.requestId);
    return entry.handle.request;
  }

  isCurrent(handle: RequestHandle<T>): boolean {
    const entry = this.entries.get(handle.requestId);
    return entry?.handle.token === handle.token;
  }

  cancel(requestId: string): boolean {
    const entry = this.entries.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.entries.delete(requestId);
    entry.onCancel?.(entry.handle.request);
    return true;
  }
}

/**
 * Shared per-request lifecycle glue for ask-code providers: every provider
 * (claude subprocess, MiniMax fetch, ...) races several completion paths
 * (success, error, timeout, cancel) against each other and must send exactly
 * one 'done' result while always releasing its RequestRegistry slot.
 */
export class AskCodeSession<T> {
  private finished = false;

  static start<T>(
    registry: RequestRegistry<T>,
    requestId: string,
    request: T,
    send: (msg: unknown) => void,
    onCancel?: (request: T) => void,
    timeoutMs?: number,
  ): AskCodeSession<T> {
    const ref: { current?: AskCodeSession<T> } = {};
    const handle = registry.start(
      requestId,
      request,
      () => ref.current?.onTimeout(send, timeoutMs),
      onCancel,
      timeoutMs,
    );
    const session = new AskCodeSession(registry, handle);
    ref.current = session;
    return session;
  }

  constructor(
    private readonly registry: RequestRegistry<T>,
    private readonly handle: RequestHandle<T>,
  ) {}

  /** Releases this exact registry slot. Safe to call more than once. */
  cleanup(): void {
    this.registry.finish(this.handle);
  }

  /** Marks the request finished; returns false if a result was already sent. */
  complete(): boolean {
    if (this.finished) return false;
    this.finished = true;
    return true;
  }

  /** Standard timeout callback: reports the shared timeout message exactly once. */
  onTimeout(send: (msg: unknown) => void, timeoutMs?: number): void {
    if (!this.complete()) return;
    send({
      type: 'error',
      text: timeoutMs
        ? `Request timed out after ${timeoutMs / 60_000} minutes.`
        : ASK_CODE_TIMEOUT_MESSAGE,
    });
    send({ type: 'done', exitCode: 1 });
  }
}
