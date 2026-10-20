import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readContextUsage } from '../shared/agent-chat-types.js';
import { unifiedDiff, wholeFileDiff } from '../shared/chat-diffs.js';
import type {
  ChatDecision,
  ChatDiff,
  ChatItem,
  ChatImage,
  ChatModel,
  ChatCommand,
  AgentChatState,
} from '../shared/agent-chat-types.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
const string = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Codex sends a whole file for an add or delete and a unified diff for an update. */
function changeDiff(value: unknown): ChatDiff | undefined {
  const change = record(value);
  const path = string(change.path);
  if (!path) return undefined;
  const text = string(change.diff);
  const kind = string(record(change.kind).type) || string(change.kind);
  if (!/^@@ /m.test(text) && (kind === 'add' || kind === 'delete'))
    return wholeFileDiff(path, text, kind === 'add' ? '+' : '-');
  return unifiedDiff(path, text);
}

function chatItem(value: unknown, completed = true): ChatItem | undefined {
  const item = record(value);
  const id = string(item.id);
  if (!id) return;
  if (item.type === 'agentMessage') return { id, kind: 'assistant', text: string(item.text) };
  if (item.type === 'userMessage') {
    const content = Array.isArray(item.content) ? item.content : [];
    const images = content.flatMap<ChatImage>((part) => {
      const input = record(part);
      if (input.type !== 'image') return [];
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+=*)$/.exec(
        string(input.url),
      );
      return match
        ? [
            {
              name: 'Attached image',
              mediaType: match[1] as ChatImage['mediaType'],
              data: match[2],
            },
          ]
        : [];
    });
    return {
      id,
      kind: 'user',
      text: content
        .map((part) => string(record(part).text))
        .filter(Boolean)
        .join('\n'),
      ...(images.length ? { images } : {}),
    };
  }
  let status: NonNullable<ChatItem['activity']>['status'] =
    item.status === 'inProgress' || !completed ? 'running' : 'completed';
  if (
    item.status === 'failed' ||
    item.error ||
    record(item.result).isError === true ||
    (typeof item.exitCode === 'number' && item.exitCode !== 0)
  )
    status = 'failed';
  if (item.status === 'declined') status = 'declined';
  if (item.type === 'commandExecution') {
    const files = (Array.isArray(item.commandActions) ? item.commandActions : []).flatMap(
      (action) =>
        record(action).type === 'read' && typeof record(action).path === 'string'
          ? [string(record(action).path)]
          : [],
    );
    return {
      id,
      kind: 'tool',
      text: string(item.aggregatedOutput),
      activity: {
        type: 'command',
        command: string(item.command),
        ...(files.length ? { files } : {}),
        label: string(item.command) || 'Shell command',
        status,
        ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
      },
    };
  }
  if (item.type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const diffs = changes.flatMap((change) => changeDiff(change) ?? []);
    return {
      id,
      kind: 'tool',
      text: '',
      activity: {
        type: 'files',
        files: diffs.map((diff) => diff.path),
        label: diffs.length === 1 ? diffs[0].path : `${diffs.length} files`,
        status,
        diffs,
      },
    };
  }
  if (item.type === 'mcpToolCall') {
    return {
      id,
      kind: 'tool',
      text: [
        `${string(item.server)} / ${string(item.tool)}: ${string(item.status)}`,
        string(record(item.error).message),
      ]
        .filter(Boolean)
        .join('\n'),
      activity: {
        type: 'tool',
        label: `${string(item.server)} / ${string(item.tool)}`,
        status,
      },
    };
  }
}

/** One official Codex app-server process per chat. No credentials leave that process. */
export class CodexChat {
  readonly state: AgentChatState = { status: 'starting', items: [], requests: [] };
  private cwd?: string;
  private skills = new Map<string, string>();
  private sequence = 0;
  private turnId?: string;
  private interruptRequested = false;
  private stopped = false;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private publishTimer?: ReturnType<typeof setTimeout>;
  private sendState: (state: AgentChatState) => void;
  private observers = new Set<(state: AgentChatState) => void>();

  constructor(
    private proc: ChildProcessWithoutNullStreams,
    publish: (state: AgentChatState) => void,
  ) {
    this.sendState = publish;
    const lines = createInterface({ input: proc.stdout });
    lines.on('line', (line) => {
      try {
        this.receive(record(JSON.parse(line)));
      } catch {
        this.fail('Codex sent an invalid app-server message. Update Codex and try again.');
        this.stop();
      }
    });
    // Drain stderr; it may contain credentials or other private diagnostics.
    proc.stderr.resume();
    proc.stdin.on('error', (err) => {
      this.fail(err.message);
      this.stop();
    });
    proc.on('error', (err) => {
      this.fail(err.message);
      this.stop();
    });
    proc.on('exit', () => {
      lines.close();
      this.fail('Codex chat disconnected. Reopen Chat to reconnect.');
      this.stop();
    });
  }

  subscribe(publish: (state: AgentChatState) => void): void {
    this.sendState = publish;
    this.publish();
  }

  observe(listener: (state: AgentChatState) => void): () => void {
    this.observers.add(listener);
    return () => this.observers.delete(listener);
  }

  async start(cwd: string, threadId?: string, skipPermissions = false): Promise<void> {
    this.cwd = cwd;
    await this.rpc('initialize', {
      clientInfo: { name: 'parallel_code', title: 'Parallel Code', version: '2.0.0' },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: 'initialized' });
    const result = record(
      await this.rpc(threadId ? 'thread/resume' : 'thread/start', {
        ...(threadId ? { threadId } : { historyMode: 'legacy' }),
        cwd,
        ...(!threadId || skipPermissions
          ? {
              approvalPolicy: skipPermissions ? 'never' : 'on-request',
              sandbox: skipPermissions ? 'danger-full-access' : 'workspace-write',
            }
          : {}),
      }),
    );
    const thread = record(result.thread);
    this.state.model = string(result.model) || undefined;
    this.state.reasoningEffort = string(result.reasoningEffort) || undefined;
    if (this.stopped) throw new Error('Codex chat stopped while connecting.');
    this.state.threadId = string(thread.id);
    if (!this.state.threadId) throw new Error('Codex did not return a conversation ID.');
    for (const turn of Array.isArray(thread.turns) ? thread.turns : []) {
      for (const item of Array.isArray(record(turn).items)
        ? (record(turn).items as unknown[])
        : []) {
        this.upsert(chatItem(item));
      }
    }
    this.interruptActivities();
    this.state.status = 'ready';
    this.publish();
    await this.loadModels();
    await this.loadSkills();
  }

  private async loadSkills(): Promise<void> {
    try {
      const result = record(await this.rpc('skills/list', { cwds: [this.cwd] }));
      if (!Array.isArray(result.data)) throw new Error('Invalid skill list.');
      const skills = new Map<string, string>();
      const commands: ChatCommand[] = [];
      for (const entry of result.data) {
        const group = record(entry);
        if (group.cwd !== this.cwd || !Array.isArray(group.skills)) continue;
        for (const value of group.skills) {
          const skill = record(value);
          const name = string(skill.name);
          const path = string(skill.path);
          if (!name || !path || skill.enabled === false || skills.has(name)) continue;
          skills.set(name, path);
          commands.push({
            name,
            description: string(skill.description),
            argumentHint: '',
            prefix: '$',
          });
        }
      }
      this.skills = skills;
      this.state.commands = commands;
    } catch {
      // Older app-servers may not support discovery; chat remains usable.
      this.skills.clear();
      this.state.commands = undefined;
    }
    this.publish();
  }

  async loadModels(): Promise<void> {
    try {
      const models: ChatModel[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const result = record(
          await this.rpc('model/list', {
            limit: 100,
            includeHidden: false,
            ...(cursor ? { cursor } : {}),
          }),
        );
        if (!Array.isArray(result.data)) throw new Error('Codex returned an invalid model list.');
        for (const value of result.data) {
          const model = record(value);
          if (!string(model.model) || model.hidden === true) continue;
          models.push({
            model: string(model.model),
            displayName: string(model.displayName) || string(model.model),
            defaultReasoningEffort: string(model.defaultReasoningEffort),
            supportedReasoningEfforts: (Array.isArray(model.supportedReasoningEfforts)
              ? model.supportedReasoningEfforts
              : []
            )
              .map(record)
              .filter((effort) => string(effort.reasoningEffort))
              .map((effort) => ({
                reasoningEffort: string(effort.reasoningEffort),
                description: string(effort.description),
              })),
          });
        }
        cursor = string(result.nextCursor) || undefined;
        if (cursor && cursors.has(cursor)) throw new Error('Codex repeated a model-list page.');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (!models.length) throw new Error('Codex returned no selectable models.');
      this.state.models = models;
      this.state.modelsError = undefined;
    } catch (error) {
      this.state.modelsError = error instanceof Error ? error.message : String(error);
    }
    this.publish();
  }

  selectModel(model: string, reasoningEffort?: string): void {
    if (this.state.status !== 'ready')
      throw new Error('Wait for Codex to finish before changing models.');
    const choice = this.state.models?.find((option) => option.model === model);
    if (!choice)
      throw new Error('This model is not available. Refresh the model list and try again.');
    const effort = reasoningEffort ?? choice.defaultReasoningEffort;
    if (
      effort &&
      !choice.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort)
    )
      throw new Error('This reasoning effort is not supported by the selected model.');
    if (this.state.model !== model) this.state.contextUsage = undefined;
    this.state.model = model;
    this.state.reasoningEffort = effort || undefined;
    this.publish();
  }

  async send(text: string, images: ChatImage[] = []): Promise<void> {
    if (this.state.status !== 'ready')
      throw new Error('Wait for Codex to finish or stop the current response.');
    this.state.status = 'working';
    this.interruptRequested = false;
    this.state.startedAt = Date.now();
    this.state.interrupted = false;
    this.state.plan = undefined;
    this.state.error = undefined;
    this.publish();
    try {
      const result = record(
        await this.rpc('turn/start', {
          threadId: this.state.threadId,
          ...(this.state.model ? { model: this.state.model } : {}),
          ...(this.state.reasoningEffort ? { effort: this.state.reasoningEffort } : {}),
          input: [
            { type: 'text', text },
            ...this.skillInput(text),
            ...images.map((image) => ({
              type: 'image',
              url: `data:${image.mediaType};base64,${image.data}`,
            })),
          ],
        }),
      );
      if (this.state.status === 'working') {
        this.turnId = string(record(result.turn).id);
        if (this.interruptRequested)
          void this.interrupt().catch((err: unknown) => {
            this.state.error = err instanceof Error ? err.message : String(err);
            this.publish();
          });
      }
    } catch (err) {
      if (!this.stopped) this.state.status = 'ready';
      this.state.error = err instanceof Error ? err.message : String(err);
      this.publish();
      throw err;
    }
  }

  private skillInput(text: string): { type: 'skill'; name: string; path: string }[] {
    const name = /^\$(\S+)(?:\s|$)/.exec(text)?.[1];
    const path = name ? this.skills.get(name) : undefined;
    return name && path ? [{ type: 'skill', name, path }] : [];
  }

  async interrupt(): Promise<void> {
    if (this.state.status !== 'working') return;
    if (!this.turnId) {
      this.interruptRequested = true;
      return;
    }
    this.interruptRequested = false;
    await this.rpc('turn/interrupt', { threadId: this.state.threadId, turnId: this.turnId });
  }

  respond(id: string | number, decision: ChatDecision, answers?: Record<string, string>): void {
    const request = this.state.requests.find((r) => r.id === id);
    if (!request) throw new Error('This request is no longer pending.');
    // Codex requests never offer to be remembered, so an "always" can only reach here
    // from a stale card; answer the one ask rather than send the app-server a word it
    // does not know.
    const answer = decision === 'decline' ? 'decline' : 'accept';
    const result =
      request.kind === 'question'
        ? {
            answers: Object.fromEntries(
              (request.questions ?? []).map((q) => [q.id, { answers: [answers?.[q.id] ?? ''] }]),
            ),
          }
        : { decision: answer };
    this.write({ id, result });
    this.state.requests = this.state.requests.filter((r) => r.id !== id);
    this.publish();
  }

  async release(): Promise<Pick<AgentChatState, 'threadId' | 'model' | 'reasoningEffort'>> {
    if (!['ready', 'closed'].includes(this.state.status) || this.state.requests.length)
      throw new Error(
        'Finish or stop the response and resolve pending requests before switching views.',
      );
    const session = {
      threadId: this.state.threadId,
      model: this.state.model,
      reasoningEffort: this.state.reasoningEffort,
    };
    await new Promise<void>((resolve, reject) => {
      if (typeof this.proc.exitCode === 'number' || typeof this.proc.signalCode === 'string') {
        resolve();
        return;
      }
      const closed = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.proc.removeListener('close', closed);
        reject(new Error('Codex has not stopped yet. Try switching again.'));
      }, 5000);
      this.proc.once('close', closed);
      this.stop();
    });
    return session;
  }

  stop(immediate = false): void {
    if (this.stopped) return;
    this.stopped = true;
    this.fail('Codex chat stopped.');
    // Own process group includes commands launched by the agent.
    const pid = this.proc.pid;
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        if (pid) process.kill(-pid, signal);
        else this.proc.kill(signal);
      } catch {
        /* The process group has already exited. */
      }
    };
    signalGroup('SIGTERM');
    // Electron exits well before a 2 s timer fires on quit, and an unref'd timer cannot
    // hold the loop open, so a group ignoring SIGTERM would outlive the app with no owner.
    if (immediate) {
      signalGroup('SIGKILL');
      return;
    }
    const hardKill = setTimeout(() => signalGroup('SIGKILL'), 2_000);
    hardKill.unref?.();
    this.proc.once('close', () => clearTimeout(hardKill));
  }

  private fail(message: string): void {
    if (this.state.status === 'closed') return;
    this.state.status = 'closed';
    this.state.error = message;
    this.state.requests = [];
    this.interruptActivities();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    this.pending.clear();
    this.publish();
  }

  private write(message: unknown): void {
    if (this.state.status === 'closed') throw new Error('Codex chat is disconnected.');
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private rpc(method: string, params: RecordValue): Promise<unknown> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex timed out during ${method}.`));
        this.stop();
      }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  private publish(): void {
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = undefined;
    this.sendState(this.state);
    for (const observer of this.observers) observer(this.state);
  }

  private upsert(item: ChatItem | undefined): void {
    if (!item) return;
    const index = this.state.items.findIndex((i) => i.id === item.id);
    if (index === -1) this.state.items.push(item);
    else this.state.items[index] = item;
  }

  private interruptActivities(): void {
    for (const item of this.state.items) {
      if (item.activity?.status === 'running')
        item.activity = { ...item.activity, status: 'interrupted' };
    }
  }

  private receive(message: RecordValue): void {
    if (this.stopped) return;
    const method = string(message.method);
    if (!method && typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(new Error(string(record(message.error).message) || 'Codex request failed.'));
      else pending.resolve(message.result);
      return;
    }
    const params = record(message.params);
    if (typeof message.id === 'string' || typeof message.id === 'number') {
      const id = message.id;
      if (
        method === 'item/commandExecution/requestApproval' ||
        method === 'item/fileChange/requestApproval'
      ) {
        const item = this.state.items.find((i) => i.id === params.itemId);
        this.state.requests.push({
          id,
          since: Date.now(),
          kind: 'approval',
          text:
            [
              string(params.reason),
              string(params.command) || item?.text,
              params.networkApprovalContext || params.additionalPermissions
                ? JSON.stringify(params.networkApprovalContext ?? params.additionalPermissions)
                : '',
              string(params.cwd),
              string(params.grantRoot),
            ]
              .filter(Boolean)
              .join('\n') || 'Allow these file changes?',
        });
      } else if (method === 'item/tool/requestUserInput') {
        const questions = Array.isArray(params.questions) ? params.questions : [];
        this.state.requests.push({
          id,
          since: Date.now(),
          kind: 'question',
          text: 'Codex needs your input',
          questions: questions.map((value) => {
            const q = record(value);
            return {
              id: string(q.id),
              question: string(q.question),
              isSecret: q.isSecret === true,
              options: (Array.isArray(q.options) ? q.options : []).map((o) => ({
                label: string(record(o).label),
                description: string(record(o).description),
              })),
            };
          }),
        });
      } else {
        // Never leave an unsupported server request hanging or silently approve it.
        this.write({
          id,
          error: { code: -32601, message: 'This request is not supported by Parallel Code chat.' },
        });
        this.state.error = `Codex requested an unsupported interaction (${method}).`;
        this.publish();
        return;
      }
    } else if (method === 'item/started' || method === 'item/completed') {
      this.upsert(chatItem(params.item, method === 'item/completed'));
    } else if (
      method === 'item/agentMessage/delta' ||
      method === 'item/commandExecution/outputDelta'
    ) {
      const id = string(params.itemId);
      let item = this.state.items.find((i) => i.id === id);
      if (!item) {
        item = { id, kind: method === 'item/agentMessage/delta' ? 'assistant' : 'tool', text: '' };
        this.state.items.push(item);
      }
      item.text += string(params.delta);
      if (!this.publishTimer) this.publishTimer = setTimeout(() => this.publish(), 50);
      return;
    } else if (method === 'thread/tokenUsage/updated') {
      if (params.threadId !== this.state.threadId) return;
      const total = record(record(params.tokenUsage).total);
      const { totalTokens, inputTokens, outputTokens } = total;
      if (
        typeof totalTokens !== 'number' ||
        !Number.isSafeInteger(totalTokens) ||
        totalTokens < 0 ||
        typeof inputTokens !== 'number' ||
        !Number.isSafeInteger(inputTokens) ||
        inputTokens < 0 ||
        typeof outputTokens !== 'number' ||
        !Number.isSafeInteger(outputTokens) ||
        outputTokens < 0
      )
        return;
      this.state.tokenUsage = { totalTokens, inputTokens, outputTokens, scope: 'conversation' };
      const usage = record(params.tokenUsage);
      this.state.contextUsage = readContextUsage(
        record(usage.last).totalTokens,
        usage.modelContextWindow,
      );
    } else if (method === 'turn/plan/updated') {
      this.state.plan = (Array.isArray(params.plan) ? params.plan : []).map((value) => {
        const entry = record(value);
        return {
          step: string(entry.step),
          status:
            entry.status === 'completed'
              ? 'completed'
              : entry.status === 'inProgress' || entry.status === 'in_progress'
                ? 'in_progress'
                : 'pending',
        };
      });
    } else if (method === 'turn/started') {
      this.turnId = string(record(params.turn).id);
      this.state.status = 'working';
    } else if (method === 'turn/completed') {
      this.state.interrupted = record(params.turn).status === 'interrupted';
      this.interruptActivities();
      this.turnId = undefined;
      this.state.status = 'ready';
      this.state.requests = [];
      const error = record(record(params.turn).error);
      if (error.message) this.state.error = string(error.message);
    } else if (method === 'serverRequest/resolved') {
      this.state.requests = this.state.requests.filter((r) => r.id !== params.requestId);
    } else if (method === 'skills/changed') {
      void this.loadSkills();
      return;
    } else if (method === 'error') {
      this.state.error = string(record(params.error).message) || 'Codex encountered an error.';
    } else return;
    this.publish();
  }
}
