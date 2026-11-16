/** Pure helpers for the task's goal and plan, which the Plan card shows; the store applies them. */
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

type GoalSource = Pick<Task, 'savedInitialPrompt' | 'initialPrompt' | 'promptHistory'>;

/** The first non-empty line of what the user asked for, whitespace collapsed. */
function promptLine(task: GoalSource): string {
  const prompt = task.savedInitialPrompt ?? task.initialPrompt ?? task.promptHistory?.[0]?.text;
  return (
    prompt
      ?.split('\n')
      .map((text) => text.replace(/\s+/g, ' ').trim())
      .find(Boolean) ?? ''
  );
}

/** The first line of what the user asked for, shortened to fit the context. */
export function taskGoal(task: GoalSource): string {
  const line = promptLine(task);
  if (!line) return '';
  return line.length > GOAL_MAX_CHARS ? `${line.slice(0, GOAL_MAX_CHARS - 1)}…` : line;
}
