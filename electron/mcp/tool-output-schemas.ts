/** Wire contracts for the selected structured MCP responses. */
import { COMPLETION_REPORT_LIMITS as limits } from '../shared/completion-report.js';

const string = { type: 'string' };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object' as const,
  properties,
  required,
});
const array = (items: unknown) => ({ type: 'array', items });
const boundedString = (bytes: number) => ({
  type: 'string',
  minLength: 1,
  maxLength: bytes,
});

const verification = object(
  {
    checks: array(
      object(
        {
          name: string,
          command: string,
          result: { enum: ['passed', 'blocked', 'failed'] },
          reason: string,
        },
        ['name', 'command', 'result'],
      ),
    ),
  },
  ['checks'],
);

export const completionReportSchema = {
  ...object(
    {
      summary: boundedString(limits.summaryBytes),
      verification: {
        ...object(
          {
            checks: {
              ...array({
                ...object(
                  {
                    name: boundedString(limits.stringBytes),
                    command: boundedString(limits.stringBytes),
                    result: { enum: ['passed', 'blocked', 'failed'] },
                    reason: boundedString(limits.stringBytes),
                  },
                  ['name', 'command', 'result'],
                ),
                additionalProperties: false,
              }),
              maxItems: limits.maxChecks,
            },
          },
          ['checks'],
        ),
        additionalProperties: false,
      },
      artifacts: {
        ...array({
          ...object(
            {
              path: boundedString(limits.pathBytes),
              label: boundedString(limits.stringBytes),
            },
            ['path'],
          ),
          additionalProperties: false,
        }),
        maxItems: limits.maxArtifacts,
      },
      unresolvedIssues: {
        ...array(boundedString(limits.stringBytes)),
        maxItems: limits.maxIssues,
      },
    },
    ['summary'],
  ),
  additionalProperties: false,
  description: `Agent-reported handoff, limited to ${limits.bytes} UTF-8 bytes by the server. String caps are also bytes; the server additionally validates repository-relative artifact paths.`,
};

const completion = object(
  {
    id: string,
    completedAt: string,
    reviewRevision: { type: 'integer', minimum: 1 },
    sourceCommit: string,
    snapshotState: { enum: ['clean', 'dirty', 'unknown'] },
    result: completionReportSchema,
  },
  ['id', 'completedAt', 'reviewRevision', 'snapshotState'],
);
const landingState = {
  enum: [
    'landing_escalated',
    'landing_failed',
    'landed_pending_review',
    'landed_cleanup_failed',
    'reviewed',
  ],
};
const landedMetadata = object(
  {
    taskId: string,
    taskName: string,
    coordinatorTaskId: string,
    targetBranch: string,
    landedCommit: string,
    landedAt: string,
    landedOrder: { type: 'integer' },
    summary: string,
    verification,
  },
  [
    'taskId',
    'taskName',
    'coordinatorTaskId',
    'targetBranch',
    'landedCommit',
    'landedAt',
    'landedOrder',
    'verification',
  ],
);
const delivery = object(
  {
    state: { enum: ['queued', 'unconfirmed'] },
    blockedBy: { enum: ['agent_startup', 'user_activity', 'agent_busy'] },
    sinceMs: { type: 'number', minimum: 0 },
  },
  ['state', 'sinceMs'],
);
const taskSummary = object(
  {
    id: string,
    name: string,
    branchName: string,
    status: string,
    coordinatorTaskId: string,
    integrationPolicy: { enum: ['review', 'automatic'] },
    signalDoneAt: string,
    reviewRevision: { type: 'integer', minimum: 0 },
    completion,
    verification,
    landingState,
    landingReason: string,
    landingSummary: string,
    landedMetadata,
    activityEvidence: object(
      {
        agentId: string,
        launchId: string,
        source: { enum: ['hook', 'terminal', 'process'] },
        activity: { enum: ['working', 'waiting', 'ready', 'turn_finished', 'unknown'] },
        event: string,
        observedAt: { type: 'number' },
        since: { type: 'number' },
        prompt: { enum: ['permission', 'question'] },
        detail: string,
        freshness: { enum: ['current', 'stale', 'unknown'] },
      },
      ['agentId', 'source', 'activity', 'event', 'freshness'],
    ),
    delivery,
  },
  ['id', 'name', 'branchName', 'status', 'coordinatorTaskId'],
);

export const toolOutputSchemas = {
  list_tasks: object({ tasks: array(taskSummary) }, ['tasks']),
  get_task_status: object(
    {
      ...taskSummary.properties,
      worktreePath: string,
      projectId: string,
      agentId: string,
      exitCode: { type: ['integer', 'null'] },
      pendingPrompt: string,
      pendingPrompts: array(string),
      pendingPromptCount: { type: 'integer', minimum: 0 },
    },
    [...taskSummary.required, 'worktreePath', 'projectId', 'agentId', 'exitCode'],
  ),
  signal_done: object({ ok: { const: true }, completion }, ['ok', 'completion']),
  land_self: object(
    {
      mainBranch: string,
      linesAdded: { type: 'integer' },
      linesRemoved: { type: 'integer' },
      landingState,
      landedMetadata,
    },
    ['mainBranch', 'linesAdded', 'linesRemoved', 'landingState', 'landedMetadata'],
  ),
  wait_for_signal_done: {
    ...object(
      {
        taskId: string,
        name: string,
        status: string,
        signalDoneAt: string,
        completion,
        remaining: { type: 'integer', minimum: 0 },
        timedOut: { const: true },
        stalled: array(
          object({ taskId: string, name: string, delivery }, ['taskId', 'name', 'delivery']),
        ),
      },
      ['remaining'],
    ),
    anyOf: [
      { required: ['taskId', 'name', 'status', 'signalDoneAt'] },
      { required: ['timedOut'] },
      { properties: { remaining: { const: 0 } } },
    ],
  },
};
