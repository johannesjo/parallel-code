import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { applyLoginShellEnv, gateIpcHandlersOn } from './login-env.js';

describe('applyLoginShellEnv', () => {
  it('merges the sentinel block, ignoring rc noise and protected runtime keys', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', NODE_OPTIONS: '--keep' };
    const dump = ['PATH=/opt/bin:/usr/bin', 'NODE_OPTIONS=--inspect', 'EMPTY=', 'A=b=c', ''].join(
      '\0',
    );
    applyLoginShellEnv(`welcome!\n__PCODE_ENV__${dump}__PCODE_ENV__\nbye`, env);
    expect(env).toEqual({ PATH: '/opt/bin:/usr/bin', NODE_OPTIONS: '--keep', EMPTY: '', A: 'b=c' });
  });

  it('leaves the environment untouched without a complete sentinel block', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    applyLoginShellEnv('__PCODE_ENV__PATH=/opt/bin', env);
    expect(env).toEqual({ PATH: '/usr/bin' });
  });
});

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function fakeIpcMain(): { ipcMain: IpcMain; invoke: (channel: string) => unknown } {
  const handlers = new Map<string, Listener>();
  const ipcMain = {
    handle: (channel: string, listener: Listener) => handlers.set(channel, listener),
  } as unknown as IpcMain;
  const invoke = (channel: string) => handlers.get(channel)?.({} as IpcMainInvokeEvent, 'arg');
  return { ipcMain, invoke };
}

describe('gateIpcHandlersOn', () => {
  it('holds handlers until the login env is ready, then passes calls straight through', async () => {
    let markReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => (markReady = resolve));
    const { ipcMain, invoke } = fakeIpcMain();
    gateIpcHandlersOn(ipcMain, ready);
    const listener = vi.fn((_event: IpcMainInvokeEvent, arg: unknown) => `got ${String(arg)}`);
    ipcMain.handle('spawn', listener);

    const early = invoke('spawn');
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();

    markReady();
    await expect(early).resolves.toBe('got arg');
    // Once settled, calls no longer wait on a microtask.
    expect(invoke('spawn')).toBe('got arg');
  });
});
