import { createSignal } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import type { CodexModelChoice } from '../../electron/shared/ask-code-models';
import { invoke } from './ipc';
import { errMessage, warn as logWarn } from './log';

const [models, setModels] = createSignal<CodexModelChoice[]>([]);
let requested = false;

/** The Codex models read from the CLI's cache; empty until the first load. */
export const codexModels = models;

/**
 * Asks the backend for the Codex model list once per session. The cache file
 * only changes when the CLI refreshes it, so every menu and select shares one
 * result instead of re-reading it on each open.
 */
export function loadCodexModels(): void {
  if (requested) return;
  requested = true;
  invoke<CodexModelChoice[]>(IPC.ListCodexModels)
    .then((list) => setModels(Array.isArray(list) ? list : []))
    .catch((error: unknown) => {
      // Allow a retry on the next open; the CLI may simply not be installed yet.
      requested = false;
      logWarn('codexModels', 'Could not list Codex models', { error: errMessage(error) });
    });
}
