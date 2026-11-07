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
/** A first line longer than this reads as a paragraph, not a goal. */
const EARLY_BRIEF_MIN_CHARS = 80;

type GoalSource = Pick<Task, 'brief' | 'savedInitialPrompt' | 'initialPrompt' | 'promptHistory'>;

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

/** The brief's goal, else the first line of what the user asked for, so the
 *  context has a goal even with task briefs turned off. */
export function taskGoal(task: GoalSource): string {
  const goal = task.brief?.brief.goal;
  if (goal) return goal;
  const line = promptLine(task);
  if (!line) return '';
  return line.length > GOAL_MAX_CHARS ? `${line.slice(0, GOAL_MAX_CHARS - 1)}…` : line;
}

/**
 * Whether to brief the task as soon as it starts instead of after its first
 * turn: until then the goal falls back to the raw prompt, which for a long
 * prompt is a paragraph cut mid-sentence.
 */
export function needsEarlyBrief(task: GoalSource): boolean {
  return !task.brief && promptLine(task).length > EARLY_BRIEF_MIN_CHARS;
}
