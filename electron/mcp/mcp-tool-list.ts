/** Pure tool-list logic — extracted so it can be unit-tested without starting the MCP server. */

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export const SUBTASK_TOOLS: ToolDef[] = [
  {
    name: 'land_self',
    description:
      'Land your own completed sub-task through the Parallel Code backend. Call this only after committing your work and running verification successfully. A successful call is terminal; do not call signal_done afterward.',
    inputSchema: {
      type: 'object',
      properties: {
        verification: {
          type: 'object',
          description: 'Structured verification showing the checks you ran and their results.',
          properties: {
            checks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  command: { type: 'string' },
                  result: { type: 'string', enum: ['passed', 'blocked', 'failed'] },
                  reason: { type: 'string' },
                },
                required: ['name', 'command', 'result'],
              },
            },
          },
          required: ['checks'],
        },
        summary: {
          type: 'string',
          description: 'Optional concise summary of what landed.',
        },
      },
      required: ['verification'],
    },
  },
  {
    name: 'signal_done',
    description:
      'Legacy/manual-review completion signal. Use land_self for normal self-landing; call signal_done only when the coordinator asked to review and land manually.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

export const COORDINATOR_TOOLS: ToolDef[] = [
  {
    name: 'create_task',
    description:
      'Create a new task with its own git worktree and AI agent. The agent starts automatically and the prompt is delivered once the agent is ready. A startup/default placeholder prompt in get_task_output is not evidence that delivery failed; wait and re-check before sending follow-up instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Task name (used for branch name)' },
        prompt: {
          type: 'string',
          description: 'Initial prompt to send to the agent once it finishes starting up.',
        },
        baseBranch: {
          type: 'string',
          description:
            'Git branch to base the worktree on. Defaults to the coordinator task branch. Only set this when deliberately overriding that default.',
        },
      },
      required: ['name', 'prompt'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List all coordinated tasks with their current status.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_task_status',
    description: 'Get detailed status of a specific task including git info and agent state.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'Task ID' } },
      required: ['taskId'],
    },
  },
  {
    name: 'send_prompt',
    description:
      "Send a follow-up instruction to a task's AI agent. The tool may report that the prompt was queued rather than sent when the initial assignment or user activity is still blocking delivery; don't call wait_for_idle until a prompt was actually sent. Do not resend the full original assignment merely because a newly created task is idle or get_task_output shows a startup/default placeholder prompt; wait briefly and re-check unless the agent clearly asks for input, starts unrelated work, or prompt delivery clearly failed.",
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' },
        prompt: { type: 'string', description: 'Prompt text to send' },
      },
      required: ['taskId', 'prompt'],
    },
  },
  {
    name: 'wait_for_idle',
    description:
      "Wait until a task's agent becomes idle (sitting at its prompt). Returns when the agent is ready for the next instruction.",
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 300000 = 5 min)',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'get_task_diff',
    description: "Get the changed files and unified diff for a task's work.",
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'Task ID' } },
      required: ['taskId'],
    },
  },
  {
    name: 'get_task_output',
    description:
      "Get recent terminal output from a task's agent (stripped of ANSI codes). A startup/default placeholder prompt, such as 'Improve documentation in @filename', can be stale while the dispatched create_task prompt is queued or being processed; do not treat it alone as a reason to resend the task.",
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'Task ID' } },
      required: ['taskId'],
    },
  },
  {
    name: 'merge_task',
    description: "Merge a task's branch into the base branch.",
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' },
        squash: { type: 'boolean', description: 'Squash merge (default: false)' },
        message: { type: 'string', description: 'Custom merge commit message' },
        cleanup: {
          type: 'boolean',
          description: 'Clean up worktree and branch after merge (default: false)',
        },
        skipVerification: {
          type: 'boolean',
          description:
            "Merge without running the project's verify command. Only for a failure the task cannot fix, e.g. a suite already red on the base branch (default: false)",
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'close_task',
    description: 'Close and clean up a task — kills the agent, removes worktree and branch.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'Task ID' } },
      required: ['taskId'],
    },
  },
  {
    name: 'wait_for_signal_done',
    description:
      'Wait for ANY sub-task to call signal_done. Returns { taskId, name, status, signalDoneAt, remaining } where remaining is the count of tasks still running or signaled-but-not-yet-reviewed. Call this in a loop until remaining === 0 to process all completed sub-tasks before spawning more. IMPORTANT: you MUST review the returned task before calling wait_for_signal_done again.',
    inputSchema: {
      type: 'object',
      properties: {
        timeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 300000 = 5 min)',
        },
      },
      required: [],
    },
  },
];

/**
 * Returns the tool list for a given role.
 * Sub-tasks (taskId set, no coordinatorId) get only sub-task scoped tools.
 * Coordinators (and plain agents) get the full coordinator set — which does NOT include signal_done.
 */
export function selectTools(taskId: string, coordinatorId: string): ToolDef[] {
  if (taskId && !coordinatorId) return SUBTASK_TOOLS;
  return COORDINATOR_TOOLS;
}
