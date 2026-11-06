/** Pure helpers for task context data; the store applies them. */
import { isPlanSteps } from '../../electron/shared/agent-plan';
import type { Task, TaskAgentPlan } from '../store/types';

/** A persisted plan, or undefined when it is missing or malformed. */
export function restoreTaskAgentPlan(value: unknown): TaskAgentPlan | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (!isPlanSteps(v.steps) || typeof v.updatedAt !== 'number') return undefined;
  return {
    steps: v.steps,
    updatedAt: v.updatedAt,
    ...(typeof v.failedCommand === 'string' && { failedCommand: v.failedCommand }),
  };
}

const GOAL_MAX_CHARS = 200;

/** The brief's goal, else the first line of what the user asked for, so the
 *  context has a goal even with task briefs turned off. */
export function taskGoal(
  task: Pick<Task, 'brief' | 'savedInitialPrompt' | 'initialPrompt' | 'promptHistory'>,
): string {
  const goal = task.brief?.brief.goal;
  if (goal) return goal;
  const prompt = task.savedInitialPrompt ?? task.initialPrompt ?? task.promptHistory?.[0]?.text;
  const line = prompt
    ?.split('\n')
    .map((text) => text.replace(/\s+/g, ' ').trim())
    .find(Boolean);
  if (!line) return '';
  return line.length > GOAL_MAX_CHARS ? `${line.slice(0, GOAL_MAX_CHARS - 1)}…` : line;
}
