import { setStore, store } from './core';
import { setTaskFocusedPanel } from './focused-panel';
import { setPrefillPrompt, setTaskPromptDraftActive } from './tasks';

/**
 * Prefills the task's prompt input for the user to read, edit and send.
 * Appended so an unsent draft survives.
 */
export function stageTaskPrompt(taskId: string, text: string): void {
  const task = store.tasks[taskId];
  if (!task) return;
  const draft = task.prefillPrompt ?? task.promptDraft ?? '';
  setTaskPromptDraftActive(taskId, true);
  setStore('showPromptInput', true);
  setPrefillPrompt(taskId, [draft, text].filter(Boolean).join('\n\n'));
  queueMicrotask(() => {
    if (store.tasks[taskId]) setTaskFocusedPanel(taskId, 'prompt');
  });
}
