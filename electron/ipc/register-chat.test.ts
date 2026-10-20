import type { BrowserWindow } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import os from 'node:os';
import { registerAllHandlers } from './register.js';
import { IPC } from './channels.js';
import * as chats from '../chat/sessions.js';
import type { AgentChat } from '../chat/types.js';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: Record<string, unknown>) => unknown>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, args: Record<string, unknown>) => unknown,
    ) => handlers.set(channel, handler),
  },
  app: { getPath: () => os.tmpdir(), isPackaged: false },
  dialog: {},
  shell: {},
  clipboard: {},
  BrowserWindow: {},
  Notification: {},
}));

afterEach(() => {
  handlers.clear();
  vi.restoreAllMocks();
});

function registerWithChat() {
  registerAllHandlers({
    on: vi.fn(),
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  } as unknown as BrowserWindow);
  const send = vi.fn(async () => {});
  vi.spyOn(chats, 'getAgentChat').mockReturnValue({ send } as unknown as AgentChat);
  const sendMessage = (args: Record<string, unknown>) =>
    handlers.get(IPC.AgentChat)?.(undefined, { action: 'send', agentId: 'agent', ...args });
  return { send, sendMessage };
}

it('delivers attached images with the message', async () => {
  const { send, sendMessage } = registerWithChat();
  const image = { name: 'shot.png', mediaType: 'image/png', data: 'AAAA' };
  await sendMessage({ text: 'Look', images: [image] });
  expect(send).toHaveBeenCalledWith('Look', [image]);
});

it('sends text alone when nothing is attached', async () => {
  const { send, sendMessage } = registerWithChat();
  await sendMessage({ text: 'Hello' });
  expect(send).toHaveBeenCalledWith('Hello', []);
});

it('rejects an attachment that is not a supported image before it reaches the agent', async () => {
  const { send, sendMessage } = registerWithChat();
  await expect(
    Promise.resolve().then(() =>
      sendMessage({
        text: 'Look',
        images: [{ name: 'a.svg', mediaType: 'image/svg+xml', data: 'AAAA' }],
      }),
    ),
  ).rejects.toThrow('Attach a PNG, JPEG, WebP, or GIF image.');
  expect(send).not.toHaveBeenCalled();
});
