// IPC tracing wrapper.
//
// Patches `ipcMain.handle` so every handler emits a debug entry on
// dispatch and on completion. Channels in SAFE_FOR_TRACE include
// their args; all others omit them by default (default-deny).

import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { debug, getMinLevel, warn, errMessage } from '../log.js';
import { IPC } from './channels.js';

/**
 * Channels whose call args may be safely included in the debug
 * trace. Defaults to empty (opt-in only). Anything carrying tokens,
 * paths under the user's home directory, file contents, or shell
 * input MUST NOT be added here.
 */
const SAFE_FOR_TRACE: ReadonlySet<string> = new Set<string>([]);

/**
 * Channels that MUST never be marked safe for tracing — even if a
 * future contributor mistakenly adds them to SAFE_FOR_TRACE. Asserted
 * at module init.
 */
const NEVER_SAFE: ReadonlySet<string> = new Set<string>([
  IPC.WriteToAgent,
  IPC.SetMinimaxApiKey,
  IPC.AskAboutCode,
  IPC.SaveAppState,
  IPC.LoadAppState,
  IPC.SaveArenaData,
  IPC.LoadArenaData,
  IPC.SaveKeybindings,
  IPC.LoadKeybindings,
  IPC.ShellOpenInEditor,
  IPC.ShellOpenFile,
  IPC.ShellReveal,
  IPC.DialogOpen,
  IPC.OpenPath,
  IPC.ReadFileText,
  IPC.ResolveClipboardPaste,
  IPC.SaveDroppedImage,
  IPC.CreateArenaWorktree,
  IPC.RemoveArenaWorktree,
  IPC.CheckPathExists,
  IPC.ResolveProjectDockerfile,
  IPC.BuildDockerImage,
]);

for (const ch of NEVER_SAFE) {
  if (SAFE_FOR_TRACE.has(ch)) {
    throw new Error(`SAFE_FOR_TRACE contains a never-safe channel: ${ch}`);
  }
}

/**
 * Patch `ipcMain.handle` to trace every dispatch. Idempotent: calling
 * twice is a no-op. Call once, before any handler is registered.
 */
export function installIpcTracing(ipcMain: IpcMain): void {
  type HandleListener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const handleProxy = ipcMain as unknown as {
    handle: (channel: string, listener: HandleListener) => void;
    __pcTracePatched?: true;
  };
  if (handleProxy.__pcTracePatched) return;

  const original = handleProxy.handle.bind(ipcMain);

  handleProxy.handle = (channel: string, listener: HandleListener): void => {
    original(channel, (event, ...args) => {
      // Fast-path: when the logger's minimum level is above `debug`, skip
      // the dispatch and completion debug entries (which are level-gated
      // anyway) but still surface failures via warn. Sync handlers keep
      // their synchronous return shape on the success path.
      if (getMinLevel() !== 'debug') {
        try {
          const result = listener(event, ...args);
          if (result instanceof Promise) {
            return result.catch((err) => {
              warn('ipc', `${channel} err`, { err: errMessage(err) });
              throw err;
            });
          }
          return result;
        } catch (err) {
          warn('ipc', `${channel} err`, { err: errMessage(err) });
          throw err;
        }
      }
      return tracedDispatch(channel, listener, event, args);
    });
  };

  handleProxy.__pcTracePatched = true;
}

async function tracedDispatch(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  event: IpcMainInvokeEvent,
  args: unknown[],
): Promise<unknown> {
  const includePayload = SAFE_FOR_TRACE.has(channel);
  debug('ipc', channel, includePayload ? { args } : undefined);
  try {
    const result = await listener(event, ...args);
    debug('ipc', `${channel} ok`);
    return result;
  } catch (err) {
    warn('ipc', `${channel} err`, { err: errMessage(err) });
    throw err;
  }
}
