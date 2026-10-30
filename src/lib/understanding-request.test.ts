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
vi.mock('../store/store', () => ({
  store: { askCodeProvider: 'claude', askCodeModel: 'sonnet', agentEnvFiles: {} },
}));
vi.mock('../store/project-path', () => ({
  projectIdForPath: (path: string) => (path === '/tmp' ? 'project-1' : undefined),
}));

import { invoke } from './ipc';
import { startUnderstandingRequest } from './understanding-request';

function start() {
  const handle = startUnderstandingRequest({
    prompt: 'p',
    cwd: '/tmp',
    request: 'tour',
    onElapsed: () => undefined,
    onReceiving: () => undefined,
    onProviderError: () => undefined,
  });
  const channel = channels.at(-1);
  if (!channel) throw new Error('no channel');
  return { handle, send: (message: Message) => channel.onmessage(message) };
}

afterEach(() => {
  channels.length = 0;
});

describe('startUnderstandingRequest', () => {
  it('runs with the env vars of the project the folder belongs to', () => {
    start();
    expect(invoke).toHaveBeenCalledWith(
      'ask_about_code',
      expect.objectContaining({ cwd: '/tmp', projectId: 'project-1' }),
    );
  });
});

describe('startUnderstandingRequest failures', () => {
  // The Claude CLI prints API errors and usage limits to stdout in text mode.
  it('reports what the provider printed when it fails without stderr', async () => {
    const { handle, send } = start();
    send({ type: 'chunk', text: 'Invalid API key\n' });
    send({ type: 'done', exitCode: 1 });
    await expect(handle.result).resolves.toEqual({
      status: 'failed',
      message: 'Invalid API key',
    });
  });

  it('falls back to a generic message when the provider printed nothing', async () => {
    const { handle, send } = start();
    send({ type: 'done', exitCode: 1 });
    await expect(handle.result).resolves.toEqual({
      status: 'failed',
      message: 'The tour provider failed. Try again.',
    });
  });
});
