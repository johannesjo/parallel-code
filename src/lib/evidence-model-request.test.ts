import { afterEach, describe, expect, it, vi } from 'vitest';

interface Message {
  type: 'chunk' | 'error' | 'done';
  text?: string;
  exitCode?: number;
}

const channels: { onmessage: (message: Message) => void }[] = [];

vi.mock('./ipc', () => ({
  invoke: vi.fn(() => Promise.resolve()),
  Channel: class {
    onmessage: (message: Message) => void = () => undefined;
    constructor() {
      channels.push(this);
    }
    dispose(): void {}
  },
}));

import { startEvidenceModelRequest } from './evidence-model-request';

function start() {
  const request = startEvidenceModelRequest({
    prompt: 'p',
    cwd: '/tmp',
    settings: { provider: 'claude', model: 'haiku' },
    agentEnvFiles: {},
    purpose: 'brief',
  });
  const channel = channels.at(-1);
  if (!channel) throw new Error('no channel');
  return { request, send: (message: Message) => channel.onmessage(message) };
}

afterEach(() => {
  channels.length = 0;
});

describe('startEvidenceModelRequest', () => {
  it('resolves with the streamed response on success', async () => {
    const { request, send } = start();
    send({ type: 'chunk', text: '{"a":' });
    send({ type: 'chunk', text: '1}' });
    send({ type: 'done', exitCode: 0 });
    await expect(request.result).resolves.toBe('{"a":1}');
  });

  it('reports stderr when the provider fails', async () => {
    const { request, send } = start();
    send({ type: 'chunk', text: 'partial' });
    send({ type: 'error', text: 'boom on stderr' });
    send({ type: 'done', exitCode: 1 });
    await expect(request.result).rejects.toThrow('boom on stderr');
  });

  // The Claude CLI prints API errors and usage limits to stdout in text mode.
  it('reports what the provider printed when it fails without stderr', async () => {
    const { request, send } = start();
    send({ type: 'chunk', text: 'API Error: 529 Overloaded\n' });
    send({ type: 'done', exitCode: 1 });
    await expect(request.result).rejects.toThrow('API Error: 529 Overloaded');
  });

  // Seen with an invalid API key: stderr holds an unrelated warning, stdout the error.
  it('reports both streams when stderr holds only a warning', async () => {
    const { request, send } = start();
    send({ type: 'chunk', text: 'Invalid API key · Fix external API key\n' });
    send({ type: 'error', text: '⚠ claude.ai connectors are disabled\n' });
    send({ type: 'done', exitCode: 1 });
    const error = await request.result.catch((e: unknown) => e);
    expect(String(error)).toContain('Invalid API key');
    expect(String(error)).toContain('connectors are disabled');
  });

  // MiniMax and Codex stream model output, then may fail with a network error or timeout.
  it('keeps the error first when long model output preceded it', async () => {
    const { request, send } = start();
    send({ type: 'chunk', text: '{"partial":"' + 'x'.repeat(5_000) });
    send({ type: 'error', text: 'Request timed out after 2 minutes.' });
    send({ type: 'done', exitCode: 1 });
    const error = await request.result.catch((e: unknown) => e);
    expect(String(error)).toMatch(/^Error: Request timed out after 2 minutes\./);
  });

  it('falls back to a generic message when the provider printed nothing', async () => {
    const { request, send } = start();
    send({ type: 'done', exitCode: 1 });
    await expect(request.result).rejects.toThrow('The model provider failed.');
  });
});
