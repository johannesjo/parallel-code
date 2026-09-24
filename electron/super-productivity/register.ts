/**
 * IPC for the Super Productivity integration. Every channel is narrow and
 * validates its arguments; the renderer never sees the token or a generic
 * "request anything" proxy.
 */
import { ipcMain } from 'electron';
import { IPC } from '../ipc/channels.js';
import { assertOptionalString, assertString, assertStringArray } from '../ipc/validate.js';
import { getUserDataDir } from '../user-data-dir.js';
import { isValidSpId } from '../shared/super-productivity.js';
import { createSpClient, SP_MAX_BATCH_IDS } from './client.js';
import { clearSpToken, isValidSpToken, readSpToken, writeSpToken } from './token-store.js';
import { consumePendingSpOpen } from './protocol.js';

const MAX_TITLE_LENGTH = 500;
const MAX_NOTE_LENGTH = 2_000;

type IpcArgs = Record<string, unknown> | undefined;

function spId(value: unknown, label: string): string {
  if (!isValidSpId(value)) throw new Error(`${label} must be a Super Productivity id`);
  return value;
}

function optionalSpId(value: unknown, label: string): string | undefined {
  assertOptionalString(value, label);
  return value === undefined ? undefined : spId(value, label);
}

function boundedText(value: unknown, label: string, max: number): string {
  assertString(value, label);
  const text = value.trim();
  if (!text) throw new Error(`${label} must not be empty`);
  if (text.length > max) throw new Error(`${label} is too long`);
  return text;
}

export function registerSuperProductivityHandlers(): void {
  const userDataDir = getUserDataDir();
  let token = readSpToken(userDataDir);
  const client = createSpClient({ getToken: () => token });

  ipcMain.handle(IPC.SuperProductivityGetState, () => client.getConnectionState());

  ipcMain.handle(IPC.SuperProductivitySetToken, (_e, args: IpcArgs) => {
    const next = typeof args?.token === 'string' ? args.token.trim() : '';
    if (!isValidSpToken(next)) {
      throw new Error('That does not look like a Super Productivity access token');
    }
    writeSpToken(userDataDir, next);
    token = next;
    return client.getConnectionState();
  });

  ipcMain.handle(IPC.SuperProductivityClearToken, () => {
    clearSpToken(userDataDir);
    token = null;
    return 'not_configured' as const;
  });

  ipcMain.handle(IPC.SuperProductivityListProjects, () => client.listProjects());

  ipcMain.handle(IPC.SuperProductivityGetTracking, () => client.getTracking());

  ipcMain.handle(IPC.SuperProductivityStartTracking, (_e, args: IpcArgs) =>
    client.startTracking(spId(args?.taskId, 'taskId')),
  );

  ipcMain.handle(IPC.SuperProductivityCreateTask, (_e, args: IpcArgs) =>
    client.createTask({
      title: boundedText(args?.title, 'title', MAX_TITLE_LENGTH),
      projectId: optionalSpId(args?.projectId, 'projectId'),
      parentId: optionalSpId(args?.parentId, 'parentId'),
    }),
  );

  ipcMain.handle(IPC.SuperProductivityGetTask, (_e, args: IpcArgs) =>
    client.getTask(spId(args?.taskId, 'taskId'), {
      includeIssueUrl: args?.includeIssueUrl === true,
    }),
  );

  ipcMain.handle(IPC.SuperProductivityGetTasks, (_e, args: IpcArgs) => {
    const ids = args?.taskIds;
    assertStringArray(ids, 'taskIds');
    if (ids.length > SP_MAX_BATCH_IDS) throw new Error('taskIds has too many entries');
    return client.getTasks(ids.map((id) => spId(id, 'taskIds[]')));
  });

  ipcMain.handle(IPC.SuperProductivityRenameTask, (_e, args: IpcArgs) =>
    client.renameTask(
      spId(args?.taskId, 'taskId'),
      boundedText(args?.title, 'title', MAX_TITLE_LENGTH),
    ),
  );

  ipcMain.handle(IPC.SuperProductivityCompleteTask, (_e, args: IpcArgs) =>
    client.completeTask(
      spId(args?.taskId, 'taskId'),
      boundedText(args?.note, 'note', MAX_NOTE_LENGTH),
    ),
  );

  ipcMain.handle(IPC.SuperProductivityConsumePendingOpen, () => consumePendingSpOpen());
}
