import { Show, createEffect } from 'solid-js';
import { TaskAITerminal } from '../components/TaskAITerminal';
import { PromptInput } from '../components/PromptInput';
import { store } from '../store/core';
import { effectiveAgentId } from '../store/agent-select';
import { setActiveAgent } from '../store/navigation';
import { setTaskFocusedPanel } from '../store/focused-panel';
import { clearInitialPrompt, clearPrefillPrompt } from '../store/tasks';
import { updateProject } from '../store/projects';
import type { Project, Task } from '../store/types';
import { documentAgentTaskId, rearmDocumentAgents } from './agent-task';
import { openDocumentFile } from './store';

interface AgentTerminalProps {
  project: Project;
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

  // The task itself is not persisted; remember its first agent's CLI on the
  // project so the same one comes back after the app restarts.
  createEffect(() => {
    const defId = store.agents[firstAgentId()]?.def.id;
    if (defId && defId !== props.project.documentTerminalAgentId) {
      updateProject(props.project.id, { documentTerminalAgentId: defId });
    }
  });

  // Keyed so children get the task record itself. A non-keyed accessor
  // re-reads the project through the rail's <Show> on every access, and
  // TaskAITerminal reads the task id from its cleanups: on close that read
  // hits a memo already marked pending, which re-enters the disposal and
  // crashes inside Solid.
  return (
    <div class="docws-agent-pane">
      <Show when={task()} keyed fallback={<div class="docws-empty">No agent is installed.</div>}>
        {(t) => {
          // Before the terminals mount: they read the attach flag once, on mount.
          rearmDocumentAgents(t);
          return <AgentTask task={t} />;
        }}
      </Show>
    </div>
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

function AgentTask(props: { task: Task }) {
  return (
    <>
      <div class="docws-agent-term">
        <TaskAITerminal
          task={props.task}
          isActive
          selectedAgentId={effectiveAgentId(props.task) ?? ''}
          onSelectAgent={setActiveAgent}
          onFileLink={(filePath) => openInWorkspace(props.task.worktreePath, filePath)}
          promptHandle={undefined}
        />
      </div>
      <div class="docws-agent-prompt" onClick={() => setTaskFocusedPanel(props.task.id, 'prompt')}>
        <PromptInput
          taskId={props.task.id}
          taskName={props.task.name}
          agentId={props.task.agentIds[0] ?? ''}
          initialPrompt={props.task.initialPrompt}
          prefillPrompt={props.task.prefillPrompt}
          onSend={(text) => {
            // A prompt typed while an instruction waits leaves the wait in place.
            if (props.task.initialPrompt?.trim() === text.trim()) {
              clearInitialPrompt(props.task.id);
            }
          }}
          onPrefillConsumed={() => clearPrefillPrompt(props.task.id)}
        />
      </div>
    </>
  );
}
