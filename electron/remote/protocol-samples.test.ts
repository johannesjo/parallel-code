// One sample of every server -> phone message, shared with the Android app.
// The Android app keeps its own parser (android/.../Protocol.kt); its
// ProtocolSamplesTest parses the JSON written here. A change to protocol.ts
// that renames or retypes a field fails typechecking below, the updated
// sample changes the JSON, and the Android tests then show what the app
// must follow — instead of the app quietly dropping the message.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'prettier';
import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '../shared/agent-chat-types.js';
import type { RemoteAgent, RemoteTaskPr, ServerMessage } from './protocol.js';

const SAMPLES_PATH = join(
  import.meta.dirname,
  '../../android/app/src/test/resources/protocol-samples.json',
);

// Required<> makes a new optional field fail here until it gets a sample value.
const pr: Required<RemoteTaskPr> = {
  url: 'https://github.com/acme/web/pull/42',
  label: 'CI failed',
  kind: 'failed',
  babysit: true,
};

const agent: Required<RemoteAgent> = {
  agentId: 'agent-1',
  taskId: 'task-1',
  taskName: 'Fix login',
  status: 'running',
  exitCode: null,
  lastLine: 'Running tests…',
  projectName: 'web',
  projectColor: '#4f8cff',
  projectIcon: 'rocket',
  agentName: 'Claude Code',
  attention: 'needs_input',
  kind: 'chat',
  collapsed: true,
  suspended: false,
  ci: 'failure',
  lane: 'needs',
  pr,
};

const approval: Required<ChatRequest> = {
  id: 7,
  since: 1_700_000_000_000,
  kind: 'approval',
  text: 'Run npm test',
  action: 'Run command',
  details: 'Bash {"command":"npm test"}',
  questions: [
    {
      id: 'q1',
      question: 'Which suite?',
      isSecret: false,
      multiSelect: true,
      options: [{ label: 'unit', description: 'Fast tests' }],
    },
  ],
  defaultToNo: true,
  canAlwaysAllow: true,
  alwaysAllowNote: 'Writes .claude/settings.json',
};

// Keyed by message type, so a new server message fails typechecking until it has a sample.
const samples: { [K in ServerMessage['type']]: Extract<ServerMessage, { type: K }> } = {
  addresses: {
    type: 'addresses',
    wifi: 'http://192.168.1.20:7777',
    tailscale: 'http://100.101.102.103:7777',
    lan: ['http://192.168.1.20:7777', 'http://192.168.1.21:7777'],
  },
  output: { type: 'output', agentId: 'agent-1', data: Buffer.from('hello\r\n').toString('base64') },
  status: { type: 'status', agentId: 'agent-1', status: 'exited', exitCode: 2 },
  agents: { type: 'agents', list: [agent] },
  scrollback: {
    type: 'scrollback',
    agentId: 'agent-1',
    data: Buffer.from('$ ls\r\nREADME.md\r\n').toString('base64'),
    cols: 100,
    rows: 30,
  },
  'terminal-size': { type: 'terminal-size', agentId: 'agent-1', cols: 120, rows: 40 },
  'chat-state': {
    type: 'chat-state',
    agentId: 'agent-1',
    state: {
      status: 'working',
      model: 'claude-opus-5-5',
      items: [
        { id: 'i1', kind: 'user', text: 'Run the tests' },
        {
          id: 'i2',
          kind: 'tool',
          text: '2 passed',
          activity: {
            type: 'command',
            label: 'npm test',
            status: 'completed',
            command: 'npm test',
          },
        },
      ],
      requests: [approval],
      error: 'Rate limited',
    },
  },
  'input-result': { type: 'input-result', requestId: 'r1', ok: false, error: 'Not paired' },
};

describe('protocol samples shared with the Android app', () => {
  it('match the committed JSON (UPDATE_PROTOCOL_SAMPLES=1 rewrites it)', async () => {
    if (process.env.UPDATE_PROTOCOL_SAMPLES === '1') {
      writeFileSync(SAMPLES_PATH, await format(JSON.stringify(samples), { parser: 'json' }));
    }
    const committed: unknown = JSON.parse(readFileSync(SAMPLES_PATH, 'utf8'));
    expect(committed).toEqual(samples);
  });
});
