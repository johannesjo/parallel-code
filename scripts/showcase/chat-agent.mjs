#!/usr/bin/env node
/* global process, setTimeout */
/**
 * Stands in for Claude Code when the app opens a task in chat view during a
 * showcase run. It speaks the CLI's stream-json protocol, the way
 * electron/chat/fixtures/claude-process.mjs does for tests, and plays the
 * task's script from chats.ts instead of calling a model. The history comes
 * from the seeded session file, which the app reads itself.
 *
 * Usage: chat-agent.mjs <script dir> [claude args...]
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const [scriptDir, ...args] = process.argv.slice(2);
const argValue = (name) =>
  args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ??
  (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sessionId = argValue('--resume') ?? argValue('--session-id');
const script = JSON.parse(readFileSync(join(scriptDir, `${sessionId}.json`), 'utf8'));

const MODELS = [
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet 5', description: '' },
];
// Replies are paced like a working agent, so recordings show them arrive.
const STEP_MS = 700;

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const assistant = (content) =>
  emit({
    type: 'assistant',
    uuid: randomUUID(),
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { id: randomUUID(), role: 'assistant', model: MODELS[0].resolvedModel, content },
  });

const toolResult = (toolUseId, output, isError = false) =>
  emit({
    type: 'user',
    uuid: randomUUID(),
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content: output, is_error: isError },
      ],
    },
  });

// Close to how often a model's text deltas arrive.
const CHUNK_MS = 10;

/**
 * Text that is still being written: the turn never ends, so the task stays working.
 * `chunks` splits it into that many deltas, CHUNK_MS apart, until `stopped()`.
 */
const streaming = async (text, chunks = 1, stopped = () => false) => {
  const id = randomUUID();
  const event = (value) =>
    emit({ type: 'stream_event', event: value, session_id: sessionId, parent_tool_use_id: null });
  event({ type: 'message_start', message: { id } });
  const size = Math.ceil(text.length / chunks);
  for (let at = 0; at < text.length; at += size) {
    if (at) await sleep(CHUNK_MS);
    if (stopped()) return;
    const delta = { type: 'text_delta', text: text.slice(at, at + size) };
    event({ type: 'content_block_delta', index: 0, delta });
  }
};

/** Ends the turn; until then the app shows the agent as working. */
const result = () =>
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Done',
    session_id: sessionId,
    uuid: randomUUID(),
  });

// An interrupt starts a new turn, which stops the steps the old one still had queued.
let turn = 0;
/** The permission request the user has not answered yet. */
let pending;

/**
 * Steps: `{ text }` says something, `{ tool, input, result? }` calls a tool
 * (still running without a result), and `{ stream, chunks? }` leaves text mid-sentence.
 * `{ approve: { tool, input }, after? }` asks for permission and waits: once
 * answered, the turn ends, with `after` said if it was allowed.
 */
const play = async (steps = []) => {
  const current = turn;
  for (const step of steps) {
    await sleep(STEP_MS);
    if (current !== turn) return;
    if (step.text) assistant([{ type: 'text', text: step.text }]);
    if (step.stream) await streaming(step.stream, step.chunks, () => current !== turn);
    const call = step.tool ? step : step.approve;
    if (!call) continue;
    const id = `toolu_${randomUUID().replaceAll('-', '')}`;
    assistant([{ type: 'tool_use', id, name: call.tool, input: call.input }]);
    if (step.result !== undefined) toolResult(id, step.result);
    if (step.approve) {
      pending = { toolUseId: id, requestId: randomUUID(), after: step.after };
      const request = {
        subtype: 'can_use_tool',
        tool_name: call.tool,
        input: call.input,
        tool_use_id: id,
      };
      emit({ type: 'control_request', request_id: pending.requestId, request });
      return;
    }
  }
};

/** The user's Allow or Decline: settle the tool call and end the turn. */
const settle = (message) => {
  if (!pending || message.response?.request_id !== pending.requestId) return;
  const { toolUseId, after } = pending;
  pending = undefined;
  const allowed = message.response.response?.behavior === 'allow';
  toolResult(toolUseId, allowed ? 'The file has been updated.' : 'The user declined.', !allowed);
  if (allowed && after) assistant([{ type: 'text', text: after }]);
  result();
};

/** Stop: drop what is still queued and any open request, then end the turn. */
const interrupt = () => {
  turn += 1;
  if (pending) emit({ type: 'control_cancel_request', request_id: pending.requestId });
  pending = undefined;
  result();
};

const INITIALIZE = {
  models: MODELS,
  commands: [],
  agents: [],
  account: {},
  output_style: 'default',
  available_output_styles: [],
};

const answer = (message) => {
  const { subtype } = message.request;
  const response =
    subtype === 'initialize'
      ? INITIALIZE
      : subtype === 'get_context_usage'
        ? { totalTokens: 38_000, rawMaxTokens: 200_000 }
        : {};
  emit({
    type: 'control_response',
    response: { subtype: 'success', request_id: message.request_id, response },
  });
  if (subtype === 'interrupt') interrupt();
  if (subtype !== 'initialize') return;
  emit({ type: 'system', subtype: 'init', session_id: sessionId, model: MODELS[0].resolvedModel });
  void play(script.start);
};

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') answer(message);
  if (message.type === 'control_response') settle(message);
  if (message.type === 'user') {
    // The CLI replays the user's message (--replay-user-messages), which is how
    // the app learns the send was accepted.
    emit({ ...message, session_id: sessionId });
    void play(script.reply);
  }
});
