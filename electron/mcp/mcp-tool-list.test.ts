import { describe, expect, it } from 'vitest';
import { parseReasoningUpdate } from '../shared/reasoning-feed.js';
import { AGENT_TOUR_LIMITS } from '../shared/agent-tour.js';
import { TOUR_CARD_LIMITS, TOUR_TONES } from '../shared/understanding-limits.js';
import { acceptUpdate, emptyHistory } from '../shared/reasoning-state.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/types.js';
import {
  selectTools,
  SUBTASK_TOOLS,
  COORDINATOR_TOOLS,
  MINDMAP_TOOLS,
  REASONING_TOOLS,
  CANVAS_VIEW_TOOLS,
  CANVAS_INSTRUCTIONS,
  TOUR_TOOLS,
  EVIDENCE_TOOLS,
  hasCanvasTools,
  type ToolDef,
} from './mcp-tool-list.js';

describe('selectTools — role-based tool list', () => {
  it('sub-task (taskId set, no coordinatorId) gets only sub-task tools', () => {
    const tools = selectTools('task-abc', '');
    expect(tools).toEqual([
      ...SUBTASK_TOOLS,
      ...MINDMAP_TOOLS,
      ...REASONING_TOOLS,
      ...CANVAS_VIEW_TOOLS,
      ...TOUR_TOOLS,
      ...EVIDENCE_TOOLS,
    ]);
    expect(tools.map((t: ToolDef) => t.name)).toStrictEqual([
      'land_self',
      'signal_done',
      'mindmap_read',
      'mindmap_update',
      'reasoning_read',
      'reasoning_update',
      'canvas_open',
      'tour_publish',
      'submit_evidence',
      'get_evidence',
    ]);
  });

  it('coordinator (coordinatorId set, no taskId) gets coordinator tools', () => {
    const tools = selectTools('', 'coordinator-xyz');
    expect(tools).toEqual([
      ...COORDINATOR_TOOLS,
      ...MINDMAP_TOOLS,
      ...REASONING_TOOLS,
      ...CANVAS_VIEW_TOOLS,
      ...TOUR_TOOLS,
      ...EVIDENCE_TOOLS,
    ]);
  });

  it('coordinator tools do NOT include signal_done', () => {
    const tools = selectTools('', 'coordinator-xyz');
    expect(tools.map((t: ToolDef) => t.name)).not.toContain('signal_done');
  });

  it('coordinator tools include the expected lifecycle tools', () => {
    const names = selectTools('', 'coordinator-xyz').map((t: ToolDef) => t.name);
    for (const expected of [
      'create_task',
      'list_tasks',
      'get_task_status',
      'send_prompt',
      'wait_for_idle',
      'wait_for_signal_done',
      'get_task_diff',
      'get_task_output',
      'merge_task',
      'close_task',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('does not advertise deprecated review_and_merge_task', () => {
    const names = selectTools('', 'coordinator-xyz').map((t: ToolDef) => t.name);
    expect(names).not.toContain('review_and_merge_task');
  });

  it('plain agent (neither taskId nor coordinatorId) gets coordinator tools', () => {
    const tools = selectTools('', '');
    expect(tools).toEqual(COORDINATOR_TOOLS);
  });

  it('coordinator tool descriptions warn against resending assignments from startup placeholders', () => {
    const byName = new Map(COORDINATOR_TOOLS.map((tool) => [tool.name, tool.description]));
    expect(byName.get('create_task')).toContain('startup/default placeholder');
    expect(byName.get('send_prompt')).toContain('Do not resend the full original assignment');
    expect(byName.get('get_task_output')).toContain('Improve documentation in @filename');
  });

  it('create_task documents the coordinator branch as the default base branch', () => {
    const createTask = COORDINATOR_TOOLS.find((tool) => tool.name === 'create_task');
    const properties = createTask?.inputSchema.properties as
      | Record<string, { description?: string }>
      | undefined;
    expect(properties?.baseBranch?.description).toContain(
      'Defaults to the coordinator task branch',
    );
  });

  it('create_task requires an initial prompt', () => {
    const createTask = COORDINATOR_TOOLS.find((tool) => tool.name === 'create_task');
    expect(createTask?.inputSchema.required).toContain('prompt');
  });

  it('create_task declares prompt as a string input', () => {
    const createTask = COORDINATOR_TOOLS.find((tool) => tool.name === 'create_task');
    const properties = createTask?.inputSchema.properties as
      | Record<string, { type?: string }>
      | undefined;
    expect(properties?.prompt?.type).toBe('string');
  });

  it('send_prompt requires a prompt', () => {
    const sendPrompt = COORDINATOR_TOOLS.find((tool) => tool.name === 'send_prompt');
    expect(sendPrompt?.inputSchema.required).toContain('prompt');
  });

  it('send_prompt requires a taskId', () => {
    const sendPrompt = COORDINATOR_TOOLS.find((tool) => tool.name === 'send_prompt');
    expect(sendPrompt?.inputSchema.required).toContain('taskId');
  });

  it('send_prompt declares taskId and prompt as string inputs', () => {
    const sendPrompt = COORDINATOR_TOOLS.find((tool) => tool.name === 'send_prompt');
    const properties = sendPrompt?.inputSchema.properties as
      | Record<string, { type?: string }>
      | undefined;
    expect(properties?.taskId?.type).toBe('string');
    expect(properties?.prompt?.type).toBe('string');
  });

  it('sub-task tools do NOT include any coordinator lifecycle tools', () => {
    const names = selectTools('task-abc', '').map((t: ToolDef) => t.name);
    for (const forbidden of ['create_task', 'merge_task', 'close_task', 'wait_for_signal_done']) {
      expect(names).not.toContain(forbidden);
    }
  });
});

it('ordinary canvas sessions advertise only map tools', () => {
  expect(selectTools('normal-task', '', true)).toEqual([
    ...MINDMAP_TOOLS,
    ...REASONING_TOOLS,
    ...CANVAS_VIEW_TOOLS,
    ...TOUR_TOOLS,
    ...EVIDENCE_TOOLS,
  ]);
});

it('explains the canvases to every session that advertises canvas tools', () => {
  expect(hasCanvasTools('normal-task', '', true)).toBe(true);
  expect(hasCanvasTools('task-abc', '')).toBe(true);
  expect(hasCanvasTools('', 'coordinator-xyz')).toBe(true);
  expect(hasCanvasTools('', '')).toBe(false);
  for (const name of ['canvas_open', 'mindmap_update', 'reasoning_update', 'reasoning graph'])
    expect(CANVAS_INSTRUCTIONS).toContain(name);
  expect(CANVAS_INSTRUCTIONS).toContain('Shape the graph to the question');
});

it('canvas_open takes exactly one of the two canvas views', () => {
  const tool = CANVAS_VIEW_TOOLS.find((t) => t.name === 'canvas_open');
  expect(tool?.inputSchema.required).toEqual(['view']);
  expect(tool?.inputSchema.properties.view).toEqual({ enum: ['mindmap', 'reasoning'] });
});

it('describes tour_publish with the caps the validator enforces', () => {
  const tool = TOUR_TOOLS.find((t) => t.name === 'tour_publish');
  expect(tool?.inputSchema.required).toEqual(['subject', 'gist', 'cards']);
  expect(tool?.inputSchema.properties.cards).toMatchObject({
    minItems: TOUR_CARD_LIMITS.minCards,
    maxItems: TOUR_CARD_LIMITS.maxCards,
  });
  expect(tool?.inputSchema.properties.subject).toMatchObject({
    maxLength: AGENT_TOUR_LIMITS.subject,
  });
  // The numbers come from the constants, so a cap change cannot leave the prompt behind.
  expect(tool?.description).toContain(`at most ${TOUR_CARD_LIMITS.body} characters`);
  expect(tool?.description).toContain(
    `${TOUR_CARD_LIMITS.minCards} and ${TOUR_CARD_LIMITS.maxCards}`,
  );
  expect(tool?.description).toContain(`at most ${AGENT_TOUR_LIMITS.context} characters`);
  expect(tool?.description).toContain(TOUR_TONES.join(', '));
  expect(tool?.description).toContain('keep mechanical cards to one or two sentences');
  expect(tool?.description).toContain('as a tour');
  expect(tool?.description).toContain('follow-up');
  expect(tool?.description).toContain(`0-${TOUR_CARD_LIMITS.questions} short, specific`);
  expect(tool?.description).toContain(`at most ${TOUR_CARD_LIMITS.question} characters each`);
  expect(tool?.description).toContain('boundary, trade-off or assumption');
});

it('advertises a self-contained reasoning example that the transaction engine accepts', () => {
  const tool = REASONING_TOOLS.find((tool) => tool.name === 'reasoning_update');
  const example = tool?.inputSchema.examples?.[0];
  expect(example).toBeDefined();
  expect(tool?.description).toContain(JSON.stringify(example));
  expect(tool?.description).toContain('Node kinds: goal, question');
  expect(REASONING_TOOLS.find((t) => t.name === 'reasoning_read')?.description).toContain(
    'workflows',
  );
  expect(tool?.description).toContain('Statuses: untested, unresolved');
  const update = parseReasoningUpdate(example);
  const { newRunId, ...command } = update;
  const history = acceptUpdate(emptyHistory(), {
    ...command,
    runId: newRunId ?? '',
    sequence: 0,
    actor: 'agent',
  });
  expect(history.snapshots[0].records).toHaveLength(3);
  expect(history.snapshots[0].relations[0]).toMatchObject({ source: 'finding', target: 'cause' });
});

describe('session capability tool sets', () => {
  const canvas = [
    'mindmap_read',
    'mindmap_update',
    'reasoning_read',
    'reasoning_update',
    'canvas_open',
    'tour_publish',
    'submit_evidence',
    'get_evidence',
  ];
  const supervision = [
    'list_tasks',
    'get_task_status',
    'send_prompt',
    'wait_for_idle',
    'get_task_diff',
    'get_task_output',
    'wait_for_signal_done',
  ];
  const names = (
    profile: 'ordinary' | 'child-review' | 'child-automatic',
    canCreate = false,
    peers = false,
  ) => selectTools('task', '', false, { profile, canCreate, peers }).map((tool) => tool.name);

  it('exposes exact ordinary rights separately from agent creation consent', () => {
    expect(names('ordinary')).toEqual([...canvas, ...supervision]);
    expect(names('ordinary', true)).toEqual([...canvas, 'create_task', ...supervision]);
  });

  it('never grants children creation even if a malformed capability requests it', () => {
    expect(names('child-review', true)).toEqual([...canvas, 'signal_done']);
    expect(names('child-automatic', true)).toEqual([...canvas, 'land_self', 'signal_done']);
  });

  it('adds only exact-session held-message tools when enabled', () => {
    expect(names('child-review', false, true)).toEqual([
      ...canvas,
      'signal_done',
      'list_agent_sessions',
      'get_agent_output',
      'send_agent_prompt',
      'wait_for_agent_prompt',
    ]);
  });

  it('uses bounded completion guidance without telling agents to self-land or auto-merge', () => {
    const tools = selectTools('parent', '', false, {
      profile: 'ordinary',
      canCreate: true,
      peers: false,
    });
    for (const name of ['wait_for_idle', 'wait_for_signal_done'])
      expect(
        tools.find((tool) => tool.name === name)?.inputSchema.properties.timeoutMs,
      ).toMatchObject({ default: 30000, maximum: 60000 });
    const child = selectTools('child', '', false, {
      profile: 'child-review',
      canCreate: false,
      peers: false,
    });
    expect(child.find((tool) => tool.name === 'signal_done')?.description).not.toContain(
      'Use land_self',
    );
  });
});

it('keeps output contracts attached across role filtering and rejects success-shaped omissions', () => {
  const validator = new AjvJsonSchemaValidator();
  const roles = [
    selectTools('', 'coordinator'),
    selectTools('child', ''),
    ...(['ordinary', 'child-review', 'child-automatic'] as const).map((profile) =>
      selectTools('task', '', false, { profile, canCreate: false, peers: false }),
    ),
  ];
  const contractedNames = [
    'get_task_status',
    'list_tasks',
    'signal_done',
    'land_self',
    'wait_for_signal_done',
  ];
  for (const tools of roles) {
    for (const tool of tools) {
      if (!contractedNames.includes(tool.name)) continue;
      expect(tool.outputSchema).toBeDefined();
      const validate = validator.getValidator(tool.outputSchema as JsonSchemaType);
      expect(validate({}).valid).toBe(false);
      if (tool.name === 'wait_for_signal_done') {
        expect(validate({ remaining: 2 }).valid).toBe(false);
        expect(validate({ remaining: -1, timedOut: true }).valid).toBe(false);
      }
      if (tool.name === 'signal_done') expect(validate({ ok: false }).valid).toBe(false);
    }
  }
});

it('advertises optional bounded completion reports while keeping empty calls valid', () => {
  const tool = SUBTASK_TOOLS.find((tool) => tool.name === 'signal_done');
  const validate = new AjvJsonSchemaValidator().getValidator(tool?.inputSchema as JsonSchemaType);
  expect(validate({}).valid).toBe(true);
  expect(
    validate({
      result: {
        summary: 'Completed the task.',
        verification: { checks: [] },
        artifacts: [{ path: 'src/main.ts' }],
        unresolvedIssues: [],
      },
    }).valid,
  ).toBe(true);
  for (const result of [
    {},
    { summary: 'x'.repeat(4097) },
    {
      summary: 'x',
      verification: {
        checks: Array(21).fill({ name: 'Test', command: 'npm test', result: 'passed' }),
      },
    },
  ])
    expect(validate({ result }).valid).toBe(false);
});
