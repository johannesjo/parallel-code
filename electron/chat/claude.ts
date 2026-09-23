import { randomUUID } from 'node:crypto';
import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentChatState,
  ChatDecision,
  ChatItem,
  ChatImage,
  ChatPermissionMode,
} from '../shared/agent-chat-types.js';
import { stripAnsi } from '../shared/prompt-detect.js';
import { readContextUsage } from '../shared/agent-chat-types.js';
import { describePermissionUpdates, describeToolCall, visibleUserText } from './describe.js';
import { chatSettingSources, launchPermissionMode, settingsDefaultMode } from './settings-mode.js';
import type { AgentChat, ChatStartOptions } from './types.js';

type ClaudeSDK = Pick<
  typeof import('@anthropic-ai/claude-agent-sdk'),
  'query' | 'getSessionMessages'
>;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown): string => (typeof value === 'string' ? value : '');
const contentText = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value
          .map((block) => string(record(block).text))
          .filter(Boolean)
          .join('\n')
      : '';

/** How long a view switch waits for the CLI to finish shutting down. */
const RELEASE_TIMEOUT_MS = 5000;

/** Owns one local Claude Code session. The SDK and binary own authentication and execution. */
export class ClaudeChat implements AgentChat {
  readonly state: AgentChatState = { status: 'starting', items: [], requests: [] };
  private query?: Query;
  private input?: SDKUserMessage;
  private wake?: () => void;
  private pendingSend?: {
    id: string;
    text: string;
    images: ChatImage[];
    resolve: () => void;
    reject: (error: Error) => void;
  };
  private observers = new Set<(state: AgentChatState) => void>();
  private permissions = new Map<
    string,
    {
      input: Record<string, unknown>;
      /** The rules that would stop this ask coming back, as the SDK suggested them. */
      suggestions?: PermissionUpdate[];
      finish: (result: PermissionResult, cancelled?: boolean) => void;
    }
  >();
  private streamId = '';
  // Both only have to survive the turn that produced them: a denied tool's result
  // arrives in the same turn, and replays repeat a message within its own turn.
  private seenToolResults = new Set<string>();
  private toolDecisions = new Map<string, 'declined' | 'interrupted'>();
  private publishTimer?: ReturnType<typeof setTimeout>;
  /** Launch output only: before the first prompt it cannot contain tool arguments. */
  private launchDiagnostics: string[] = [];
  private connecting = true;
  private contextRequest = 0;
  /** Resolves when the SDK's message stream ends — the only end-of-process
   *  signal available to `release`. */
  private reading?: Promise<void>;

  constructor(
    private sdk: ClaudeSDK | undefined,
    private opts: ChatStartOptions,
    private sendState: (state: AgentChatState) => void,
  ) {}

  async start(): Promise<void> {
    try {
      await this.connect();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const launch = this.launchDiagnostics.join('').trim();
      throw launch ? new Error(`${detail}\n${launch}`) : error;
    } finally {
      this.connecting = false;
      this.launchDiagnostics = [];
    }
  }

  private async connect(): Promise<void> {
    // The SDK history reader uses the host's config directory, not query.env. A task
    // override would write a session this app can never read back, so refuse before
    // the user has a conversation to lose rather than on the next resume.
    if (this.opts.env.CLAUDE_CONFIG_DIR !== process.env.CLAUDE_CONFIG_DIR)
      throw new Error(
        'Claude chat does not support a task-specific CLAUDE_CONFIG_DIR. Set it for Parallel Code itself.',
      );
    const sdk = this.sdk ?? (await import('@anthropic-ai/claude-agent-sdk'));
    if (this.isClosed()) throw new Error('Claude chat stopped while connecting.');
    this.sdk = sdk;
    const sessionId = this.opts.threadId ?? randomUUID();
    this.state.threadId = sessionId;
    if (this.opts.threadId) {
      const history = await sdk.getSessionMessages(sessionId, { dir: this.opts.cwd });
      for (const message of history) this.receive(message);
      this.settleActivities();
    }
    if (this.state.status === 'closed') throw new Error('Claude chat stopped while connecting.');
    // The SDK sends --permission-mode on every session it starts, defaulting the
    // option to 'default' when none is given, and that flag outranks the settings
    // file. So a chat cannot leave the choice to the CLI the way a terminal does:
    // resolve the same precedence here, or every session re-asks for the work the
    // user's permissions.defaultMode already handles.
    const settingsMode =
      this.opts.skipPermissions || this.opts.permissionMode
        ? undefined
        : await settingsDefaultMode(this.opts.cwd);
    if (this.isClosed()) throw new Error('Claude chat stopped while connecting.');
    this.query = sdk.query({
      prompt: this.prompts(),
      options: {
        cwd: this.opts.cwd,
        env: this.opts.env,
        pathToClaudeCodeExecutable: this.opts.command,
        ...(this.opts.threadId ? { resume: sessionId } : { sessionId }),
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: chatSettingSources(),
        includePartialMessages: true,
        extraArgs: {
          'replay-user-messages': null,
          ...(this.opts.mcpArgs?.[0] === '--mcp-config'
            ? { 'mcp-config': this.opts.mcpArgs[1] }
            : {}),
        },
        executable: 'node',
        permissionMode: this.opts.skipPermissions
          ? ('bypassPermissions' as const)
          : (this.opts.permissionMode ?? launchPermissionMode(settingsMode) ?? 'default'),
        ...(this.opts.skipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
        canUseTool: this.canUseTool,
        // Diagnostics can include private tool arguments once a session is running.
        // Keep the launch output only, and never forward the rest to the UI or log.
        stderr: (line) => {
          if (this.connecting && this.launchDiagnostics.length < 20)
            this.launchDiagnostics.push(line);
        },
      },
    });
    this.reading = this.read();
    await this.query.initializationResult();
    if (this.isClosed())
      throw new Error(this.state.error ?? 'Claude disconnected while connecting.');
    await this.loadModels();
    if (this.isClosed())
      throw new Error(this.state.error ?? 'Claude disconnected while connecting.');
    this.noteUnadoptedSettingsMode(settingsMode);
    // Claude reports its permission mode only in each turn's init message, so
    // until the first prompt the state would not say this session bypasses
    // permissions. It is known from how the session was launched.
    if (this.opts.skipPermissions) this.state.permissionMode = 'bypassPermissions';
    this.state.status = 'ready';
    this.publish();
    void this.refreshContextUsage();
  }

  private async refreshContextUsage(): Promise<void> {
    const request = ++this.contextRequest;
    let usage: AgentChatState['contextUsage'];
    try {
      // Summary uses the last response and local estimates, without token-count API calls.
      const response = await this.query?.getContextUsage({ detail: 'summary' });
      usage = readContextUsage(response?.totalTokens, response?.rawMaxTokens);
    } catch {
      // Older CLIs may not support context summaries; usage is optional UI metadata.
    }
    if (request !== this.contextRequest || this.isClosed()) return;
    this.state.contextUsage = usage;
    this.publish();
  }

  /**
   * A chat will not put itself in bypassPermissions because a settings file asks
   * for it: that belongs to the task's own "skip permissions" switch, which is
   * what passes the CLI its opt-in flag. Say so rather than leave the user
   * wondering why their settings stopped applying.
   */
  private noteUnadoptedSettingsMode(settingsMode: string | undefined): void {
    if (settingsMode !== 'bypassPermissions') return;
    this.state.permissionNote =
      'Your settings use bypassPermissions, which chat does not turn on by itself. This chat asks instead; switch the task to skip permissions to run without prompts.';
  }

  subscribe(publish: (state: AgentChatState) => void): void {
    this.sendState = publish;
    this.publish();
  }
  observe(listener: (state: AgentChatState) => void): () => void {
    this.observers.add(listener);
    return () => this.observers.delete(listener);
  }

  async loadModels(): Promise<void> {
    try {
      if (!this.query) throw new Error('Claude is not connected.');
      const models = await this.query.supportedModels();
      this.state.models = models
        .map((model) => ({
          model: model.resolvedModel ?? model.value,
          displayName: model.displayName,
          supportedReasoningEfforts: (model.supportedEffortLevels ?? []).map((reasoningEffort) => ({
            reasoningEffort,
            description: '',
          })),
        }))
        .filter(
          (model, index, all) => all.findIndex((other) => other.model === model.model) === index,
        );
      if (!this.state.models.length) throw new Error('Claude returned no selectable models.');
      this.state.modelsError = undefined;
    } catch (error) {
      this.state.modelsError = error instanceof Error ? error.message : String(error);
    }
    this.publish();
  }

  async selectModel(model: string, reasoningEffort?: string): Promise<void> {
    if (this.state.status !== 'ready' || !this.query)
      throw new Error('Wait for Claude to finish before changing models.');
    const choice = this.state.models?.find((option) => option.model === model);
    if (!choice) throw new Error('This model is not available.');
    const effort = reasoningEffort || undefined;
    if (
      effort &&
      !choice.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort)
    )
      throw new Error('This reasoning effort is not supported by the selected model.');
    // One control request applies both overrides; never write the user's settings files.
    ++this.contextRequest;
    this.state.contextUsage = undefined;
    this.state.status = 'starting';
    this.publish();
    try {
      await this.query.applyFlagSettings({
        model,
        effortLevel: (effort ?? null) as Parameters<Query['applyFlagSettings']>[0]['effortLevel'],
      });
      if (!this.isClosed()) {
        this.state.model = model;
        this.state.reasoningEffort = effort;
      }
    } finally {
      if (!this.isClosed()) {
        this.state.status = 'ready';
        void this.refreshContextUsage();
      }
      this.publish();
    }
  }

  async setPermissionMode(mode: ChatPermissionMode): Promise<void> {
    if (this.isClosed() || !this.query) throw new Error('Reconnect Chat before changing this.');
    if (this.opts.skipPermissions)
      throw new Error('This task skips permissions; turn that off to choose a mode.');
    await this.query.setPermissionMode(mode);
    this.state.permissionMode = mode;
    // The user has now chosen for themselves what the settings could not carry over.
    this.state.permissionNote = undefined;
    this.publish();
  }

  send(text: string, images: ChatImage[] = []): Promise<void> {
    if (this.state.status !== 'ready' || !this.query)
      return Promise.reject(new Error('Wait for Claude to finish or reconnect.'));
    this.state.status = 'working';
    this.state.startedAt = Date.now();
    this.state.interrupted = false;
    this.state.plan = undefined;
    this.state.error = undefined;
    const id = randomUUID();
    const accepted = new Promise<void>((resolve, reject) => {
      this.pendingSend = { id, text, images, resolve, reject };
    });
    this.input = {
      type: 'user',
      uuid: id,
      session_id: this.state.threadId,
      message: {
        role: 'user',
        content: images.length
          ? [
              { type: 'text', text },
              ...images.map((image) => ({
                type: 'image' as const,
                source: { type: 'base64' as const, media_type: image.mediaType, data: image.data },
              })),
            ]
          : text,
      },
      parent_tool_use_id: null,
    };
    this.publish();
    this.wake?.();
    return accepted;
  }

  async interrupt(): Promise<void> {
    if (this.state.status !== 'working' || !this.query) return;
    // A queued prompt may not have reached the CLI yet. Closing is the only certain
    // cancellation before its receipt; keep the draft and allow a clean reconnect.
    if (this.pendingSend) {
      this.stop();
      return;
    }
    await this.query.interrupt();
    this.state.interrupted = true;
    this.publish();
    // The result event marks the turn finished. Keep Send disabled until it arrives.
  }

  respond(id: string | number, decision: ChatDecision, answers?: Record<string, string>): void {
    const permission = this.permissions.get(String(id));
    if (!permission) throw new Error('This request is no longer pending.');
    const request = this.state.requests.find((request) => request.id === id);
    if (
      decision !== 'decline' &&
      request?.questions?.some((question) => !answers?.[question.id]?.trim())
    )
      throw new Error('Answer every question before continuing.');
    const remember = decision === 'accept-always' && !!permission.suggestions?.length;
    permission.finish(
      decision === 'decline'
        ? {
            behavior: 'deny',
            message: 'User declined this request.',
            decisionClassification: 'user_reject',
          }
        : {
            behavior: 'allow',
            updatedInput:
              request?.kind === 'question' ? { ...permission.input, answers } : permission.input,
            // Remembering is the agent's own suggestion; an ask that offered none is
            // allowed this once, which is all "always" could have meant for it.
            ...(remember ? { updatedPermissions: permission.suggestions } : {}),
            decisionClassification: remember ? 'user_permanent' : 'user_temporary',
          },
    );
  }

  stop(_immediate = false): void {
    if (this.isClosed()) return;
    this.fail('Claude chat stopped. Reopen Chat to reconnect.');
    // shortcut: `immediate` cannot be honoured — the Agent SDK's Query exposes only a
    // cooperative close(), no child handle to signal. On quit the CLI may outlive us
    // briefly. Upgrade path: have the SDK expose the child pid, then SIGKILL it here.
    this.query?.close();
  }

  /**
   * Hand the session over to the terminal.
   *
   * There is no child handle to wait on (see `stop`), so the end of the SDK's
   * message stream stands in for "the CLI has finished with the transcript".
   * A timeout rejects rather than resolving early: resuming a session another
   * process may still be writing is how a conversation gets mangled.
   */
  async release(): Promise<Pick<AgentChatState, 'threadId'>> {
    if (this.state.requests.length || !['ready', 'closed'].includes(this.state.status))
      throw new Error(
        'Finish or stop the response and resolve pending requests before switching views.',
      );
    const reading = this.reading;
    this.stop();
    if (reading) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Claude has not stopped yet. Try switching again.')),
          RELEASE_TIMEOUT_MS,
        );
      });
      // Clearing the timer keeps the losing promise from rejecting unhandled.
      try {
        await Promise.race([reading, expired]);
      } finally {
        clearTimeout(timer);
      }
    }
    return { threadId: this.state.threadId };
  }

  private isClosed(): boolean {
    return this.state.status === 'closed';
  }
  private async *prompts(): AsyncGenerator<SDKUserMessage> {
    while (!this.isClosed()) {
      if (!this.input)
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
      this.wake = undefined;
      if (this.isClosed()) return;
      const input = this.input;
      this.input = undefined;
      if (input) yield input;
    }
  }
  private async read(): Promise<void> {
    try {
      if (!this.query) return;
      for await (const message of this.query) {
        // Drain to the end of the stream even once closed, rather than leaving
        // the loop: `release` waits on this promise to know the CLI has let go,
        // and a trailing message would otherwise settle it while it still has
        // the transcript open. Closed means stop reporting, not stop waiting.
        if (!this.isClosed()) this.receive(message);
      }
      if (!this.isClosed()) this.fail('Claude chat disconnected. Reopen Chat to reconnect.');
    } catch (error) {
      if (!this.isClosed()) this.fail(error instanceof Error ? error.message : String(error));
    } finally {
      this.query?.close();
    }
  }
  private acceptSend(): void {
    const pending = this.pendingSend;
    if (!pending) return;
    this.pendingSend = undefined;
    this.upsert({
      id: pending.id,
      kind: 'user',
      text: pending.text,
      ...(pending.images.length ? { images: pending.images } : {}),
    });
    pending.resolve();
  }
  private fail(message: string): void {
    if (this.isClosed()) return;
    this.state.status = 'closed';
    this.state.error = message;
    this.pendingSend?.reject(new Error(message));
    this.pendingSend = undefined;
    this.input = undefined;
    this.wake?.();
    this.clearPermissions();
    this.settleActivities();
    this.publish();
  }
  private clearPermissions(): void {
    for (const permission of this.permissions.values())
      permission.finish({ behavior: 'deny', message: 'The request was cancelled.' }, true);
  }
  private settleActivities(): void {
    for (const item of this.state.items)
      if (item.activity?.status === 'running')
        item.activity = { ...item.activity, status: 'interrupted' };
  }
  private publish(): void {
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = undefined;
    this.sendState(this.state);
    for (const listener of this.observers) listener(this.state);
  }
  private upsert(item: ChatItem): void {
    const index = this.state.items.findIndex((existing) => existing.id === item.id);
    if (index < 0) this.state.items.push(item);
    else this.state.items[index] = item;
  }

  private canUseTool: CanUseTool = async (tool, input, options) => {
    this.acceptSend();
    if (this.isClosed() || options.signal.aborted)
      return { behavior: 'deny', message: 'Request cancelled.' };
    const id = randomUUID();
    const questions =
      tool === 'AskUserQuestion' && Array.isArray(input.questions)
        ? input.questions.map((value) => {
            const question = record(value);
            return {
              id: string(question.question),
              question: string(question.question),
              isSecret: false,
              multiSelect: question.multiSelect === true,
              options: (Array.isArray(question.options) ? question.options : []).map((value) => ({
                label: string(record(value).label),
                description: string(record(value).description),
              })),
            };
          })
        : undefined;
    if (
      tool === 'AskUserQuestion' &&
      (!questions?.length || questions.some((question) => !question.id))
    )
      return {
        behavior: 'deny',
        message: 'Unsupported question format. Ask the user in a normal message.',
      };
    return new Promise<PermissionResult>((resolve) => {
      const cancel = () => finish({ behavior: 'deny', message: 'Request cancelled.' }, true);
      const finish = (result: PermissionResult, cancelled = false) => {
        if (result.behavior === 'deny')
          this.toolDecisions.set(options.toolUseID, cancelled ? 'interrupted' : 'declined');
        options.signal.removeEventListener('abort', cancel);
        this.permissions.delete(id);
        this.state.requests = this.state.requests.filter((request) => request.id !== id);
        resolve(result);
        this.publish();
      };
      // An ask the agent marked unrememberable keeps no suggestions at all, so no
      // later answer can write the rules it asked us not to offer.
      const suggestions =
        options.suppressAlwaysAllowRule === true ? undefined : options.suggestions;
      this.permissions.set(id, { input, suggestions, finish });
      this.state.requests.push({
        id,
        since: Date.now(),
        kind: questions ? 'question' : 'approval',
        questions,
        // Claude asks that this one never be approvable by a stray keystroke.
        defaultToNo: options.defaultToNo === true,
        // A question is answered, not permitted; remembering an answer means nothing.
        canAlwaysAllow: !questions && !!suggestions?.length,
        alwaysAllowNote: suggestions?.length ? describePermissionUpdates(suggestions) : undefined,
        action: options.displayName,
        // The CLI writes this prompt for its own UI; only describe the call ourselves
        // when it sent none. Its text may carry ANSI escapes, which say nothing here
        // and can garble the sentence the user is deciding on.
        text: stripAnsi(
          [
            options.title || describeToolCall(tool, input),
            options.description,
            options.decisionReason,
            options.blockedPath,
          ]
            .filter(Boolean)
            .join('\n'),
        ),
        details: `${tool}\n${JSON.stringify(input, null, 2)}`,
      });
      options.signal.addEventListener('abort', cancel, { once: true });
      this.publish();
    });
  };

  private receive(value: unknown): void {
    const message = record(value);
    if (message.parent_tool_use_id) return; // Subagents are represented by their parent tool activity.
    if (message.type === 'system' && (message.subtype === 'init' || message.subtype === 'status')) {
      if (message.subtype === 'init') this.state.model = string(message.model) || this.state.model;
      // What the CLI resolved, which is not always what the settings asked for.
      this.state.permissionMode = string(message.permissionMode) || this.state.permissionMode;
      if (this.state.permissionMode !== 'default') this.state.permissionNote = undefined;
    } else if (message.type === 'stream_event') {
      this.acceptSend();
      const event = record(message.event);
      if (event.type === 'message_start') this.streamId = string(record(event.message).id);
      if (
        event.type === 'content_block_delta' &&
        this.streamId &&
        record(event.delta).type === 'text_delta'
      ) {
        const id = `${this.streamId}:${event.index}`;
        const item = this.state.items.find((item) => item.id === id);
        this.upsert({
          id,
          kind: 'assistant',
          text: (item?.text ?? '') + string(record(event.delta).text),
        });
        if (!this.publishTimer) this.publishTimer = setTimeout(() => this.publish(), 50);
        return;
      }
    } else if (message.type === 'assistant' || message.type === 'user') {
      if (message.type === 'assistant' || message.uuid === this.pendingSend?.id) this.acceptSend();
      const body = record(message.message);
      const id = string(body.id) || string(message.uuid);
      if (!id) return;
      const content = Array.isArray(body.content)
        ? body.content
        : [{ type: 'text', text: string(body.content) }];
      if (message.type === 'user' && !message.isSynthetic) {
        // A message this app already rendered stands as the user wrote it: the CLI
        // injects reminders and notifications into the turn it replays back, but a
        // user who types those tags themselves must still see their own words.
        const shown = this.state.items.some((item) => item.id === id && item.kind === 'user');
        const text = shown ? '' : visibleUserText(contentText(content));
        if (text) {
          const images = content.flatMap<ChatImage>((part) => {
            const block = record(part),
              source = record(block.source);
            return block.type === 'image' &&
              source.type === 'base64' &&
              ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(
                string(source.media_type),
              ) &&
              typeof source.data === 'string'
              ? [
                  {
                    name: 'Attached image',
                    mediaType: source.media_type as ChatImage['mediaType'],
                    data: source.data,
                  },
                ]
              : [];
          });
          this.upsert({ id, kind: 'user', text, ...(images.length ? { images } : {}) });
        }
      }
      content.forEach((value, index) => {
        const block = record(value);
        if (message.type === 'assistant' && block.type === 'text')
          this.upsert({ id: `${id}:${index}`, kind: 'assistant', text: string(block.text) });
        if (block.type === 'tool_use') {
          const tool = string(block.name),
            input = record(block.input);
          const type =
            tool === 'Bash'
              ? 'command'
              : ['Edit', 'Write', 'MultiEdit'].includes(tool)
                ? 'files'
                : 'tool';
          if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
            this.state.plan = input.todos.map((value) => {
              const todo = record(value);
              return {
                step: string(todo.content),
                status:
                  todo.status === 'completed'
                    ? 'completed'
                    : todo.status === 'in_progress'
                      ? 'in_progress'
                      : 'pending',
              };
            });
          }
          this.upsert({
            id: string(block.id),
            kind: 'tool',
            text: `${describeToolCall(tool, input)}\n\n${JSON.stringify(input, null, 2)}`,
            activity: {
              type,
              files: typeof input.file_path === 'string' ? [input.file_path] : undefined,
              label: string(input.command) || string(input.file_path) || tool,
              status: 'running',
            },
          });
        }
        if (block.type === 'tool_result') {
          const resultId = `${string(message.uuid)}:${string(block.tool_use_id)}`;
          if (this.seenToolResults.has(resultId)) return;
          this.seenToolResults.add(resultId);
          const toolId = string(block.tool_use_id);
          const previous = this.state.items.find((item) => item.id === toolId);
          this.upsert({
            id: toolId,
            kind: 'tool',
            // A blank line so the call stays legible above its output, which for a
            // failure is the error text the user came to read.
            text: [previous?.text, contentText(block.content)].filter(Boolean).join('\n\n'),
            activity: {
              ...previous?.activity,
              type: previous?.activity?.type ?? 'tool',
              label: previous?.activity?.label ?? 'Tool activity',
              status: this.toolDecisions.get(toolId) ?? (block.is_error ? 'failed' : 'completed'),
            },
          });
        }
      });
    } else if (message.type === 'result') {
      // modelUsage is already cumulative across turns and includes subagents.
      // Summing result.usage would instead omit those calls and double-count replays.
      const models = Object.values(record(message.modelUsage));
      let inputTokens = 0;
      let outputTokens = 0;
      const valid =
        models.length > 0 &&
        models.every((value) => {
          const usage = record(value);
          const counts = [
            usage.inputTokens,
            usage.cacheReadInputTokens,
            usage.cacheCreationInputTokens,
            usage.outputTokens,
          ];
          if (
            !counts.every(
              (count) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0,
            )
          )
            return false;
          inputTokens +=
            Number(usage.inputTokens) +
            Number(usage.cacheReadInputTokens) +
            Number(usage.cacheCreationInputTokens);
          outputTokens += Number(usage.outputTokens);
          return true;
        });
      if (valid && Number.isSafeInteger(inputTokens + outputTokens))
        this.state.tokenUsage = {
          totalTokens: inputTokens + outputTokens,
          inputTokens,
          outputTokens,
          scope: 'connection',
        };
      if (message.is_error) {
        const error =
          contentText(message.errors) ||
          (Array.isArray(message.errors) ? message.errors.join('\n') : '') ||
          // A 'success' subtype also sets is_error when the turn ended on an API or
          // billing failure; that cause is in `result`, and `errors` is absent.
          string(message.result) ||
          'Claude could not complete this turn.';
        this.pendingSend?.reject(new Error(error));
        this.pendingSend = undefined;
        this.state.error = error;
      } else this.acceptSend();
      this.state.status = 'ready';
      this.clearPermissions();
      this.settleActivities();
      this.seenToolResults.clear();
      this.toolDecisions.clear();
      void this.refreshContextUsage();
    } else return;
    this.publish();
  }
}
