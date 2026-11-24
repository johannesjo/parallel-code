/**
 * Separate tasks an agent suggests through `suggest_task`. They wait on the
 * suggesting task as preview cards; only the user starts one, edits it first or
 * dismisses it.
 */
import { produce } from 'solid-js/store';
import {
  parseTaskSuggestionRequest,
  pruneTaskSuggestions,
  TASK_SUGGESTION_LIMITS,
  type TaskSuggestion,
  type TaskSuggestionResult,
} from '../../electron/shared/task-suggestion';
import { store, setStore } from './core';
import { toggleNewTaskPanel } from './navigation';
import { createTask } from './tasks';
import { newTaskGitDefaults } from './task-git-defaults';
import { linkTaskToIssueReference } from './github-issue-link';
import type { Task } from './types';

function ownTask(taskId: string): Task | undefined {
  return Object.hasOwn(store.tasks, taskId) ? store.tasks[taskId] : undefined;
}

function newSuggestionId(): string {
  return `suggestion_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

export function pendingTaskSuggestions(task: Pick<Task, 'taskSuggestions'>): TaskSuggestion[] {
  return task.taskSuggestions?.filter((s) => s.status === 'pending') ?? [];
}

function findSuggestion(taskId: string, suggestionId: string): TaskSuggestion | undefined {
  return ownTask(taskId)?.taskSuggestions?.find((s) => s.id === suggestionId);
}

/** Moves a pending suggestion to its answer; an answered one stays as it was. */
function answer(
  taskId: string,
  suggestionId: string,
  status: Exclude<TaskSuggestion['status'], 'pending'>,
  startedTaskId?: string,
): boolean {
  let changed = false;
  setStore(
    produce((s) => {
      const list = s.tasks[taskId]?.taskSuggestions;
      const target = list?.find((item) => item.id === suggestionId);
      if (!list || !target || target.status !== 'pending') return;
      target.status = status;
      target.answeredAt = Date.now();
      if (startedTaskId) target.startedTaskId = startedTaskId;
      s.tasks[taskId].taskSuggestions = pruneTaskSuggestions(list);
      changed = true;
    }),
  );
  return changed;
}

const ANSWER_MESSAGES: Record<TaskSuggestion['status'], string> = {
  pending: 'Withdrawn.',
  started:
    'Not withdrawn: the user already started it as a task. That answer is final; do not retry or do the work here.',
  dismissed:
    'Not withdrawn: the user already dismissed it. That answer is final; do not suggest it again.',
  withdrawn: 'Already withdrawn.',
};

/** Handles an agent's `suggest_task` or `withdraw_task_suggestion` call for its own task. */
export function changeTaskSuggestions(taskId: string, input: unknown): TaskSuggestionResult {
  const request = parseTaskSuggestionRequest(input);
  const task = ownTask(taskId);
  if (!task || task.closingStatus) throw new Error('Task not available.');
  if (request.action === 'withdraw') {
    const current = findSuggestion(taskId, request.suggestionId);
    if (!current) throw new Error('No suggestion with that suggestionId on this task.');
    const withdrawn = answer(taskId, request.suggestionId, 'withdrawn');
    return {
      action: 'withdraw',
      suggestionId: request.suggestionId,
      withdrawn,
      status: withdrawn ? 'withdrawn' : current.status,
      message: withdrawn ? ANSWER_MESSAGES.pending : ANSWER_MESSAGES[current.status],
    };
  }
  const pending = pendingTaskSuggestions(task);
  if (pending.length >= TASK_SUGGESTION_LIMITS.pending)
    throw new Error(
      `This task already shows ${pending.length} suggestions the user has not answered. Withdraw one that matters less, or wait.`,
    );
  // A repeat of a suggestion still on screen returns the card already shown.
  const repeat = pending.find(
    (s) => s.title.toLowerCase() === request.title.toLowerCase() && s.prompt === request.prompt,
  );
  if (repeat) return { action: 'suggest', suggestionId: repeat.id, status: 'pending' };
  const suggestion: TaskSuggestion = {
    id: newSuggestionId(),
    title: request.title,
    tldr: request.tldr,
    prompt: request.prompt,
    createdAt: Date.now(),
    status: 'pending',
  };
  setStore('tasks', taskId, 'taskSuggestions', (list) => [...(list ?? []), suggestion]);
  return { action: 'suggest', suggestionId: suggestion.id, status: 'pending' };
}

export function dismissTaskSuggestion(taskId: string, suggestionId: string): void {
  answer(taskId, suggestionId, 'dismissed');
}

/** Records the task the user started from a suggestion, through either path. */
export function markTaskSuggestionStarted(
  taskId: string,
  suggestionId: string,
  startedTaskId: string,
): void {
  answer(taskId, suggestionId, 'started', startedTaskId);
}

/**
 * Starts the suggestion as a top-level task in the suggesting task's project,
 * with its agent and sandbox and the New Task dialog's Git defaults. It stays in
 * the background: the user is reading the suggesting task.
 */
export async function startTaskSuggestion(taskId: string, suggestionId: string): Promise<string> {
  const task = ownTask(taskId);
  const suggestion = findSuggestion(taskId, suggestionId);
  if (!task || !suggestion || suggestion.status !== 'pending')
    throw new Error('This suggestion is no longer available.');
  const project = store.projects.find((p) => p.id === task.projectId);
  if (!project) throw new Error('Project not found');
  const agentId = task.agentIds[0];
  const agentDef =
    (agentId ? store.agents[agentId]?.def : undefined) ??
    store.availableAgents.find((a) => a.id === store.lastAgentId) ??
    store.availableAgents[0];
  if (!agentDef) throw new Error('No agent available to start the task.');
  const startedTaskId = await createTask({
    name: suggestion.title,
    agentDef,
    projectId: project.id,
    ...(await newTaskGitDefaults(project)),
    initialPrompt: suggestion.prompt,
    // An agent wrote this prompt, so it gets the same bypass rule as its children.
    skipPermissions: task.propagateSkipPermissions === true,
    dockerMode: task.dockerMode,
    dockerSource: task.dockerSource,
    dockerImage: task.dockerImage,
    activate: false,
  });
  markTaskSuggestionStarted(taskId, suggestionId, startedTaskId);
  void linkTaskToIssueReference(startedTaskId, project.path, suggestion.prompt);
  return startedTaskId;
}

/**
 * Opens the New Task form prefilled with the suggestion, so the user can change
 * the prompt, agent or branch first. Never replaces an open form or its draft.
 */
export function editTaskSuggestion(taskId: string, suggestionId: string): boolean {
  const task = ownTask(taskId);
  const suggestion = findSuggestion(taskId, suggestionId);
  if (!task || !suggestion || suggestion.status !== 'pending' || store.showNewTaskPanel)
    return false;
  setStore('newTaskDropUrl', null);
  setStore('newTaskPrefillPrompt', {
    prompt: suggestion.prompt,
    name: suggestion.title,
    projectId: task.projectId,
    taskSuggestion: { taskId, suggestionId },
  });
  toggleNewTaskPanel(true);
  return true;
}
