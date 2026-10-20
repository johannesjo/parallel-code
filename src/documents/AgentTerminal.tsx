import { createEffect } from 'solid-js';
import { HiddenAgentPane } from '../components/HiddenAgentPane';
import { store } from '../store/core';
import { updateProject } from '../store/projects';
import type { Project } from '../store/types';
import { documentAgentTaskId } from './agent-task';
import { openDocumentFile } from './store';

interface AgentTerminalProps {
  project: Project;
  visible?: boolean;
}

/**
 * The project's long-running interactive agents, in the terminal, prompt box
 * and agent chips a task has. They work in the checkout with the user
 * watching, so their edits show up in the viewer as they land and are
 * committed as manual edits before the next run. The sessions outlive the
 * workspace: closing and reopening re-attaches.
 */
export function AgentTerminal(props: AgentTerminalProps) {
  const task = () => store.tasks[documentAgentTaskId(props.project.id)];
  const firstAgentId = () => task()?.agentIds[0] ?? '';

  // Remember the preferred CLI even if the task is later recreated.
  createEffect(() => {
    const defId = store.agents[firstAgentId()]?.def.id;
    if (defId && defId !== props.project.documentTerminalAgentId) {
      updateProject(props.project.id, { documentTerminalAgentId: defId });
    }
  });

  return (
    <HiddenAgentPane
      task={task()}
      visible={props.visible !== false}
      fallback={<div class="docws-empty">No agent is installed.</div>}
      onFileLink={(filePath) => openInWorkspace(props.project.path, filePath)}
    />
  );
}

/** A path the agent printed inside the project opens in the viewer, where the
 *  work is; anything else keeps the terminal's own Markdown viewer. */
function openInWorkspace(projectPath: string, filePath: string): boolean {
  // A project added with a trailing slash would otherwise look for `…//`.
  const root = `${projectPath.replace(/\/+$/, '')}/`;
  if (!filePath.startsWith(root)) return false;
  void openDocumentFile(filePath.slice(root.length));
  return true;
}
