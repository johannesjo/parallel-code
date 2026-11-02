/**
 * Inputs for a drafted pull request: the repo's PR template, a one-off model
 * draft, and drafts the task's agent publishes through `pr_draft_publish`.
 */
import { createSignal } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import { BRIEF_MODELS, type BriefModelId } from '../../electron/shared/task-name-model';
import type { CommitInfo } from '../ipc/types';
import { invoke } from '../lib/ipc';
import { startModelRequest } from '../lib/model-request';
import { parsePrDraft, type PrDraft } from '../../electron/shared/pr-draft';
import {
  PR_TEMPLATE_PATHS,
  buildPrDescriptionPrompt,
  parsePrDescriptionResponse,
} from '../lib/pr-description';
import { store } from './core';
import { babysitAgentBlocker } from './pr-babysit';
import { sendPrompt } from './tasks';
import { promptsSince, readTaskDiff } from './task-brief';
import type { Task } from './types';

/** The first PR template GitHub would use for this worktree, or undefined when it has none. */
export async function readPrTemplate(worktreePath: string): Promise<string | undefined> {
  for (const path of PR_TEMPLATE_PATHS) {
    const text = await invoke<string>(IPC.ReadFileText, {
      filePath: `${worktreePath}/${path}`,
    }).catch(() => undefined); // Most repos have none at most of these paths.
    if (text?.trim()) return text;
  }
  return undefined;
}

export interface PrDraftRequest {
  result: Promise<PrDraft>;
  cancel: () => void;
}

/** Drafts a title and description with a separate model, from the task's prompts, commits and diff. */
export function startPrDraft(
  task: Task,
  input: { commits: readonly CommitInfo[]; template?: string; model: BriefModelId },
): PrDraftRequest {
  let cancelRequest: (() => void) | undefined;
  let cancelled = false;
  const run = async (): Promise<PrDraft> => {
    const rawDiff = await readTaskDiff(task);
    if (cancelled) throw new Error('Cancelled');
    const request = startModelRequest({
      prompt: buildPrDescriptionPrompt({
        taskName: task.name,
        prompts: promptsSince(task, 0),
        commits: input.commits,
        rawDiff,
        template: input.template,
      }),
      cwd: task.worktreePath,
      settings: BRIEF_MODELS[input.model],
      agentEnvFiles: store.agentEnvFiles,
      projectId: task.projectId,
      purpose: 'pr-description',
    });
    cancelRequest = request.cancel;
    return parsePrDescriptionResponse(await request.result);
  };
  return {
    result: run(),
    cancel: () => {
      cancelled = true;
      cancelRequest?.();
    },
  };
}

// Kept in memory only: a draft outlives a closed dialog, not a restart.
const [agentDrafts, setAgentDrafts] = createSignal<Record<string, PrDraft>>({});

/** The draft the task's agent last published that the dialog has not taken yet. */
export function agentPrDraft(taskId: string): PrDraft | undefined {
  return agentDrafts()[taskId];
}

/** Hands the agent's draft to the dialog once; it does not fill the fields twice. */
export function takeAgentPrDraft(taskId: string): PrDraft | undefined {
  const draft = agentDrafts()[taskId];
  if (!draft) return undefined;
  setAgentDrafts((drafts) => {
    const rest = { ...drafts };
    delete rest[taskId];
    return rest;
  });
  return draft;
}

/** Accepts a draft the agent published through the `pr_draft_publish` MCP tool. */
export function publishAgentPrDraft(taskId: string, input: unknown): void {
  const draft = parsePrDraft(input);
  if (!Object.hasOwn(store.tasks, taskId) || store.tasks[taskId].closingStatus)
    throw new Error('Task not available.');
  setAgentDrafts((drafts) => ({ ...drafts, [taskId]: draft }));
}

/** Why the task's agent cannot draft right now; null when it can take the request. */
export function agentDraftBlocker(taskId: string): string | null {
  const agentId = store.tasks[taskId]?.agentIds[0];
  const tools = agentId ? store.agents[agentId]?.canvasTools : undefined;
  if (tools === false) return 'Its session has no Parallel Code tools';
  const blocker = babysitAgentBlocker(taskId);
  if (blocker) return blocker;
  return tools === undefined ? 'Checking its session tools…' : null;
}

/** Asks the task's agent to draft the PR; its answer arrives through `publishAgentPrDraft`. */
export async function requestAgentPrDraft(taskId: string, base: string): Promise<void> {
  const agentId = store.tasks[taskId]?.agentIds[0];
  if (!agentId) throw new Error('The task has no agent.');
  takeAgentPrDraft(taskId);
  await sendPrompt(
    taskId,
    agentId,
    `Draft the pull request for this task's branch into ${base}, then publish it with the pr_draft_publish tool. ` +
      `Base it on what you know about this work and on the branch's commits and diff against ${base}. ` +
      'Do not push, commit, create the pull request or change files: I review the draft in Parallel Code and create the PR there.',
    { appPrompt: true },
  );
}
