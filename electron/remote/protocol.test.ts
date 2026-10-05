import { describe, expect, it } from 'vitest';
import { parseClientMessage } from './protocol.js';

describe('acknowledged input validation', () => {
  const input = {
    type: 'input',
    agentId: 'agent-1',
    data: 'hello',
    requestId: 'reply-1',
    submit: true,
  };
  it('retains delivery IDs and the submit flag', () => {
    expect(parseClientMessage(JSON.stringify(input))).toEqual(input);
  });
  it('retains a shell prefix keystroke', () => {
    const shell = { ...input, prefixKey: '!' };
    expect(parseClientMessage(JSON.stringify(shell))).toEqual(shell);
  });
  it.each([
    { requestId: 12 },
    { requestId: '' },
    { requestId: 'x'.repeat(81) },
    { submit: 'true' },
    { data: 'x'.repeat(4097) },
    { prefixKey: 33 },
    { prefixKey: '' },
    { prefixKey: 'rm -rf /' },
  ])('rejects invalid delivery fields %j', (invalid) => {
    expect(parseClientMessage(JSON.stringify({ ...input, ...invalid }))).toBeNull();
  });
});

describe('chat message validation', () => {
  const action = {
    type: 'chat-action',
    agentId: 'agent-1',
    requestId: 'chat-1',
    action: 'send',
    params: { text: 'hello' },
  };
  it('accepts chat subscriptions and actions', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'chat-subscribe', agentId: 'a' }))).toEqual({
      type: 'chat-subscribe',
      agentId: 'a',
    });
    expect(parseClientMessage(JSON.stringify(action))).toEqual(action);
  });
  it('defaults missing params to none', () => {
    const { params: _params, ...bare } = { ...action, action: 'interrupt' };
    expect(parseClientMessage(JSON.stringify(bare))).toEqual({ ...bare, params: {} });
  });
  it.each([
    { requestId: undefined },
    { requestId: '' },
    { action: 'setPermissionMode' },
    { action: 'stop' },
    { params: ['hello'] },
    { params: 'hello' },
  ])('rejects %j', (invalid) => {
    expect(parseClientMessage(JSON.stringify({ ...action, ...invalid }))).toBeNull();
  });
});

describe('parseClientMessage view-size', () => {
  it('accepts a size and a bare release', () => {
    expect(
      parseClientMessage(JSON.stringify({ type: 'view-size', agentId: 'a', cols: 60, rows: 50 })),
    ).toEqual({ type: 'view-size', agentId: 'a', cols: 60, rows: 50 });
    expect(parseClientMessage(JSON.stringify({ type: 'view-size', agentId: 'a' }))).toEqual({
      type: 'view-size',
      agentId: 'a',
    });
  });

  it('rejects partial or out-of-range sizes', () => {
    for (const size of [
      { cols: 60 },
      { cols: 0, rows: 50 },
      { cols: 60, rows: 501 },
      { cols: 1.5, rows: 2 },
    ]) {
      expect(
        parseClientMessage(JSON.stringify({ type: 'view-size', agentId: 'a', ...size })),
      ).toBeNull();
    }
  });
});
