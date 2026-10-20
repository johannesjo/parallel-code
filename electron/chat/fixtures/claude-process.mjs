// Deterministic Claude Code wire-protocol fixture. Never invokes an agent or a model.
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { createInterface } from 'node:readline';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2);
const arg = (name) =>
  args.find((value) => value.startsWith(name + '='))?.slice(name.length + 1) ??
  (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sessionId = arg('--resume') ?? arg('--session-id');
const directory = join(
  process.env.CLAUDE_CONFIG_DIR,
  'projects',
  process.cwd().replace(/[^a-zA-Z0-9]/g, '-'),
);
mkdirSync(directory, { recursive: true });
const file = join(directory, `${sessionId}.jsonl`);
let parentUuid = null;
let model = 'claude-fixture';
let timer;
let permission;
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const record = (message) => {
  appendFileSync(
    file,
    `${JSON.stringify({ ...message, parentUuid, sessionId, cwd: process.cwd(), isSidechain: false, timestamp: new Date().toISOString() })}\n`,
  );
  parentUuid = message.uuid;
  emit(message);
};
if (arg('--resume')) {
  const entries = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  parentUuid = entries.at(-1)?.uuid ?? null;
}
const models = [
  {
    value: 'fixture',
    resolvedModel: 'claude-fixture',
    displayName: 'Claude Fixture',
    description: 'Local fixture',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'high'],
  },
];
const result = (error) =>
  emit({
    type: 'result',
    subtype: error ? 'error_during_execution' : 'success',
    is_error: !!error,
    errors: error ? [error] : undefined,
    result: error ? undefined : 'Done',
    session_id: sessionId,
    uuid: randomUUID(),
  });
function reply() {
  const id = randomUUID();
  emit({
    type: 'stream_event',
    event: { type: 'message_start', message: { id } },
    session_id: sessionId,
    parent_tool_use_id: null,
  });
  emit({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello from ' },
    },
    session_id: sessionId,
    parent_tool_use_id: null,
  });
  timer = setTimeout(() => {
    record({
      type: 'assistant',
      uuid: randomUUID(),
      session_id: sessionId,
      message: {
        id,
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello from the Claude fixture.' }],
        model,
      },
    });
    result();
  }, 150);
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (process.env.CLAUDE_FIXTURE_LOG) appendFileSync(process.env.CLAUDE_FIXTURE_LOG, line + '\n');
  if (message.type === 'control_request') {
    const request = message.request;
    let response = {};
    if (request.subtype === 'initialize')
      response = {
        models,
        commands: [],
        agents: [],
        account: {},
        output_style: 'default',
        available_output_styles: [],
      };
    if (request.subtype === 'apply_flag_settings') model = request.settings.model ?? model;
    if (request.subtype === 'get_context_usage')
      response = { totalTokens: 50000, rawMaxTokens: 200000 };
    emit({
      type: 'control_response',
      response: { subtype: 'success', request_id: message.request_id, response },
    });
    if (request.subtype === 'initialize')
      emit({ type: 'system', subtype: 'init', session_id: sessionId, model });
    if (request.subtype === 'interrupt') {
      clearTimeout(timer);
      if (permission) emit({ type: 'control_cancel_request', request_id: permission.requestId });
      permission = undefined;
      result();
    }
  }
  if (message.type === 'user') {
    if (message.message.content === '/error') {
      result('Fixture rejected send');
      return;
    }
    record(message);
    const text = message.message.content;
    if (text === '/approval' || text === '/question') {
      const id = randomUUID(),
        requestId = randomUUID();
      const tool = text === '/approval' ? 'Bash' : 'AskUserQuestion';
      const input =
        tool === 'Bash'
          ? { command: 'fixture-command' }
          : {
              questions: [
                {
                  question: 'Which features?',
                  multiSelect: true,
                  options: [
                    { label: 'A', description: 'First' },
                    { label: 'B', description: 'Second' },
                  ],
                },
              ],
            };
      record({
        type: 'assistant',
        uuid: randomUUID(),
        session_id: sessionId,
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: [{ type: 'tool_use', id, name: tool, input }],
        },
      });
      permission = { id, requestId };
      emit({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'can_use_tool', tool_name: tool, input, tool_use_id: id },
      });
    } else if (text === '/slow') timer = setTimeout(reply, 20_000);
    else reply();
  }
  if (message.type === 'control_response' && permission) {
    const output = message.response.response;
    record({
      type: 'user',
      uuid: randomUUID(),
      session_id: sessionId,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: permission.id,
            content: output.behavior === 'allow' ? 'Approved fixture output' : 'Declined',
            is_error: output.behavior !== 'allow',
          },
        ],
      },
    });
    permission = undefined;
    reply();
  }
});
