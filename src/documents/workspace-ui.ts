/**
 * Panel state of the open workspace: the project's files, which rail tab is
 * up, the one-shot output being read, and whether the interactive agent is
 * live. Kept apart from the document store because none of it is about the
 * document.
 */
import { createStore } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { errMessage } from '../lib/log';

export type RailTab = 'agent' | 'runs' | 'files';

/** A one-shot candidate whose output is open for reading. */
export interface OutputTarget {
  runId: string;
  candidateId: string;
}

interface WorkspaceUiState {
  files: string[];
  filesError: string | null;
  railTab: RailTab;
  output: OutputTarget | null;
  /** Set once the interactive agent's terminal has a live process behind it. */
  agentRunning: boolean;
}

const [ui, setUi] = createStore<WorkspaceUiState>({
  files: [],
  filesError: null,
  railTab: 'agent',
  output: null,
  agentRunning: false,
});

export { ui as workspaceUi };

export async function loadDocumentFiles(projectRoot: string): Promise<void> {
  try {
    const files = await invoke<string[]>(IPC.ListDocumentFiles, { projectRoot });
    setUi({ files, filesError: null });
  } catch (err) {
    setUi({ files: [], filesError: errMessage(err) });
  }
}

export function setRailTab(tab: RailTab): void {
  setUi('railTab', tab);
}

export function openCandidateOutput(target: OutputTarget | null): void {
  setUi('output', target);
}

export function setAgentRunning(running: boolean): void {
  setUi('agentRunning', running);
}

/** Back to the defaults when a workspace opens; files are per project. */
export function resetWorkspaceUi(): void {
  setUi({ files: [], filesError: null, railTab: 'agent', output: null, agentRunning: false });
}
