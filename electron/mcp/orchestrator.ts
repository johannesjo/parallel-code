// Main-process task orchestration for coordinating agents.
// Manages task lifecycle independently of the SolidJS renderer,
// using existing backend primitives (pty, git, tasks).

import { randomUUID } from 'crypto';
import type { BrowserWindow } from 'electron';
import { createTask as createBackendTask, deleteTask } from '../ipc/tasks.js';
import {
  spawnAgent,
  writeToAgent,
  killAgent,
  subscribeToAgent,
  unsubscribeFromAgent,
  getAgentScrollback,
  onPtyEvent,
} from '../ipc/pty.js';
import { getChangedFiles, getAllFileDiffs, mergeTask as gitMergeTask } from '../ipc/git.js';
import { stripAnsi, chunkContainsAgentPrompt } from './prompt-detect.js';
import type { OrchestratedTask, ApiTaskSummary, ApiTaskDetail, ApiDiffResult } from './types.js';
import { IPC } from '../ipc/channels.js';

const DEFAULT_WAIT_TIMEOUT_MS = 300_000; // 5 minutes
const PROMPT_WRITE_DELAY_MS = 50;

export class Orchestrator {
  private tasks = new Map<string, OrchestratedTask>();
  private tailBuffers = new Map<string, string>();
  private idleResolvers = new Map<string, Array<() => void>>();
  private subscribers = new Map<string, (encoded: string) => void>();
  private decoders = new Map<string, TextDecoder>();
  private win: BrowserWindow | null = null;
  private projectRoot: string | null = null;
  private projectId: string | null = null;
  private defaultCoordinatorTaskId: string | null = null;
  constructor() {
    // Listen for PTY exits to update task status when agents are killed externally
    // (e.g., user closes a child task from the UI).
    // No cleanup needed — orchestrator lives for the entire app lifetime.
    onPtyEvent('exit', (agentId, data) => {
      for (const task of this.tasks.values()) {
        if (task.agentId === agentId) {
          const { exitCode } = (data ?? {}) as { exitCode?: number };
          task.status = 'exited';
          task.exitCode = exitCode ?? null;
          // Resolve any idle waiters so they don't hang
          const resolvers = this.idleResolvers.get(task.id);
          if (resolvers?.length) {
            for (const resolve of resolvers) resolve();
            this.idleResolvers.delete(task.id);
          }
          break;
        }
      }
    });
  }

  setWindow(win: BrowserWindow): void {
    this.win = win;
  }

  setDefaultProject(projectId: string, projectRoot: string, coordinatorTaskId?: string): void {
    this.projectId = projectId;
    this.projectRoot = projectRoot;
    if (coordinatorTaskId) this.defaultCoordinatorTaskId = coordinatorTaskId;
  }

  async createTask(opts: {
    name: string;
    prompt?: string;
    coordinatorTaskId: string;
    projectId?: string;
    projectRoot?: string;
    agentCommand?: string;
    agentArgs?: string[];
  }): Promise<OrchestratedTask> {
    const root = opts.projectRoot ?? this.projectRoot;
    const projId = opts.projectId ?? this.projectId;
    if (!root || !projId) throw new Error('No project configured for orchestrator');

    // Create worktree + branch via existing backend
    const result = await createBackendTask(opts.name, root, ['.claude', 'node_modules'], 'task');

    const coordinatorId = opts.coordinatorTaskId !== 'api'
      ? opts.coordinatorTaskId
      : (this.defaultCoordinatorTaskId ?? opts.coordinatorTaskId);

    const agentId = randomUUID();
    const task: OrchestratedTask = {
      id: result.id,
      name: opts.name,
      projectId: projId,
      branchName: result.branch_name,
      worktreePath: result.worktree_path,
      agentId,
      coordinatorTaskId: coordinatorId,
      status: 'creating',
      exitCode: null,
    };

    this.tasks.set(task.id, task);
    this.tailBuffers.set(agentId, '');

    // Subscribe to PTY output for prompt detection
    const decoder = new TextDecoder();
    this.decoders.set(agentId, decoder);

    const outputCb = (encoded: string) => {
      const bytes = Buffer.from(encoded, 'base64');
      const text = (this.decoders.get(agentId) ?? new TextDecoder()).decode(bytes, {
        stream: true,
      });
      const prev = this.tailBuffers.get(agentId) ?? '';
      const combined = prev + text;
      this.tailBuffers.set(
        agentId,
        combined.length > 4096 ? combined.slice(combined.length - 4096) : combined,
      );

      // Check for agent prompt
      const stripped = stripAnsi(combined)
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (chunkContainsAgentPrompt(stripped)) {
        if (task.status === 'running') {
          task.status = 'idle';
        }
        // Resolve any waiting promises
        const resolvers = this.idleResolvers.get(task.id);
        if (resolvers?.length) {
          for (const resolve of resolvers) resolve();
          this.idleResolvers.delete(task.id);
        }
      } else if (task.status === 'idle') {
        task.status = 'running';
      }
    };
    this.subscribers.set(agentId, outputCb);

    // Spawn the agent process
    if (!this.win) throw new Error('No window set on orchestrator');

    const command = opts.agentCommand ?? 'claude';
    const args = opts.agentArgs ?? [];
    const channelId = randomUUID();

    spawnAgent(this.win, {
      taskId: task.id,
      agentId,
      command,
      args,
      cwd: result.worktree_path,
      env: {},
      cols: 120,
      rows: 40,
      onOutput: { __CHANNEL_ID__: channelId },
    });

    // Subscribe for output monitoring
    subscribeToAgent(agentId, outputCb);
    task.status = 'running';

    // Check scrollback in case the prompt was emitted before we subscribed
    const scrollback = getAgentScrollback(agentId);
    if (scrollback) {
      const decoded = Buffer.from(scrollback, 'base64').toString('utf8');
      const stripped = stripAnsi(decoded)
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (chunkContainsAgentPrompt(stripped)) {
        task.status = 'idle';
      }
    }

    // Notify renderer with the prompt — the renderer sets it as initialPrompt
    // on the task, and PromptInput auto-delivers it using the same code path
    // as manually created tasks (stability checks, quiescence detection, etc.)
    this.notifyRenderer(IPC.MCP_TaskCreated, {
      taskId: task.id,
      name: task.name,
      projectId: task.projectId,
      branchName: task.branchName,
      worktreePath: task.worktreePath,
      agentId: task.agentId,
      coordinatorTaskId: task.coordinatorTaskId,
      prompt: opts.prompt,
    });

    return task;
  }

  listTasks(): ApiTaskSummary[] {
    return Array.from(this.tasks.values()).map((t) => ({
      id: t.id,
      name: t.name,
      branchName: t.branchName,
      status: t.status,
      coordinatorTaskId: t.coordinatorTaskId,
    }));
  }

  getTaskStatus(taskId: string): ApiTaskDetail | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    return {
      id: task.id,
      name: task.name,
      branchName: task.branchName,
      worktreePath: task.worktreePath,
      projectId: task.projectId,
      agentId: task.agentId,
      status: task.status,
      coordinatorTaskId: task.coordinatorTaskId,
      exitCode: task.exitCode,
      pendingPrompt: task.pendingPrompt,
    };
  }

  async sendPrompt(taskId: string, prompt: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // Send text then Enter separately (like the frontend does)
    writeToAgent(task.agentId, prompt);
    await new Promise((r) => setTimeout(r, PROMPT_WRITE_DELAY_MS));
    writeToAgent(task.agentId, '\r');
    task.status = 'running';
    task.pendingPrompt = undefined;
  }

  waitForIdle(taskId: string, timeoutMs?: number): Promise<void> {
    return this.waitForIdleInternal(taskId, timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  }

  private waitForIdleInternal(taskId: string, timeoutMs: number): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return Promise.reject(new Error(`Task not found: ${taskId}`));
    if (task.status === 'idle' || task.status === 'exited') return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const resolvers = this.idleResolvers.get(taskId);
        if (resolvers) {
          const idx = resolvers.indexOf(resolve);
          if (idx >= 0) resolvers.splice(idx, 1);
        }
        reject(new Error(`Timed out waiting for task ${taskId} to become idle`));
      }, timeoutMs);

      const wrappedResolve = () => {
        clearTimeout(timer);
        resolve();
      };

      let resolvers = this.idleResolvers.get(taskId);
      if (!resolvers) {
        resolvers = [];
        this.idleResolvers.set(taskId, resolvers);
      }
      resolvers.push(wrappedResolve);
    });
  }

  async getTaskDiff(taskId: string): Promise<ApiDiffResult> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const [files, diff] = await Promise.all([
      getChangedFiles(task.worktreePath),
      getAllFileDiffs(task.worktreePath),
    ]);

    return { files, diff };
  }

  getTaskOutput(taskId: string): string {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // Try scrollback buffer first, fall back to tail buffer
    const scrollback = getAgentScrollback(task.agentId);
    if (scrollback) {
      const decoded = Buffer.from(scrollback, 'base64').toString('utf8');
      return stripAnsi(decoded);
    }
    return stripAnsi(this.tailBuffers.get(task.agentId) ?? '');
  }

  async mergeTask(
    taskId: string,
    opts?: { squash?: boolean; message?: string; cleanup?: boolean },
  ): Promise<{ mainBranch: string; linesAdded: number; linesRemoved: number }> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const root = this.projectRoot;
    if (!root) throw new Error('No project root configured');

    const result = await gitMergeTask(
      root,
      task.branchName,
      opts?.squash ?? false,
      opts?.message ?? null,
      opts?.cleanup ?? false,
    );

    if (opts?.cleanup) {
      await this.cleanupTask(taskId);
    }

    return {
      mainBranch: result.main_branch,
      linesAdded: result.lines_added,
      linesRemoved: result.lines_removed,
    };
  }

  async closeTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    await this.cleanupTask(taskId);
  }

  private async cleanupTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    // Unsubscribe from PTY output
    const cb = this.subscribers.get(task.agentId);
    if (cb) {
      unsubscribeFromAgent(task.agentId, cb);
      this.subscribers.delete(task.agentId);
    }

    // Kill the agent
    try {
      killAgent(task.agentId);
    } catch {
      /* already dead */
    }

    // Remove worktree
    const root = this.projectRoot;
    if (root) {
      try {
        await deleteTask([task.agentId], task.branchName, true, root);
      } catch (err) {
        console.warn('Failed to delete orchestrated task worktree:', err);
      }
    }

    // Clean up internal state
    this.tailBuffers.delete(task.agentId);
    this.decoders.delete(task.agentId);
    this.idleResolvers.delete(taskId);
    this.tasks.delete(taskId);

    // Notify renderer
    this.notifyRenderer(IPC.MCP_TaskClosed, { taskId });
  }

  getTask(taskId: string): OrchestratedTask | undefined {
    return this.tasks.get(taskId);
  }

  private notifyRenderer(channel: string, data: unknown): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, data);
    }
  }
}
