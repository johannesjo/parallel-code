/**
 * The agent's own to-do list, as Claude Code's TodoWrite tool states it.
 * Pure: shared by the chat backend, the hook server and the renderer.
 */

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanStep {
  step: string;
  status: PlanStepStatus;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** TodoWrite's `todos`, or undefined when the input has none. Each call
 *  carries the whole list, so a result always replaces the previous plan.
 *  Steps without text are dropped; they would render as blank rows. */
export function parseTodoWriteInput(input: unknown): PlanStep[] | undefined {
  const todos = asRecord(input).todos;
  if (!Array.isArray(todos)) return undefined;
  return todos
    .map((value) => {
      const todo = asRecord(value);
      return {
        step: typeof todo.content === 'string' ? todo.content : '',
        status:
          todo.status === 'completed' || todo.status === 'in_progress' ? todo.status : 'pending',
      } satisfies PlanStep;
    })
    .filter((todo) => todo.step);
}

const STATUSES: ReadonlySet<unknown> = new Set(['pending', 'in_progress', 'completed']);

/** Shape check for plans crossing IPC or read back from disk. */
export function isPlanSteps(value: unknown): value is PlanStep[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      const step = asRecord(item);
      return typeof step.step === 'string' && STATUSES.has(step.status);
    })
  );
}
