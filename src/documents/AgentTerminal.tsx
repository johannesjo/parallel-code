import { Show, createEffect, onCleanup } from 'solid-js';
import { TaskAITerminal } from '../components/TaskAITerminal';
import { PromptInput } from '../components/PromptInput';
import { setStore, store } from '../store/core';
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
          onCleanup(() => {
            // Exit events are not delivered while the terminal is unmounted.
            // Reattach first next time, but resume if its process has gone away.
            for (const id of t.agentIds) {
              if (store.agents[id]) setStore('agents', id, 'resumed', true);
            }
          });
          return <AgentTask task={t} visible={props.visible !== false} />;
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

function AgentTask(props: { task: Task; visible: boolean }) {
  const resumed = () => store.agents[props.task.agentIds[0]]?.resumed === true;
  return (
    <>
      <div class="docws-agent-term">
        <TaskAITerminal
          task={props.task}
          isActive
          visible={props.visible}
          selectedAgentId={effectiveAgentId(props.task) ?? ''}
          onSelectAgent={setActiveAgent}
          onFileLink={(filePath) => openInWorkspace(props.task.worktreePath, filePath)}
          promptHandle={undefined}
        />
      </div>
      <div class="docws-agent-prompt" onClick={() => setTaskFocusedPanel(props.task.id, 'prompt')}>
        <Show when={resumed() && props.task.initialPrompt}>
          <div class="docws-muted">
            Review the terminal session before sending this instruction.
          </div>
        </Show>
        <PromptInput
          taskId={props.task.id}
          taskName={props.task.name}
          agentId={props.task.agentIds[0] ?? ''}
          initialPrompt={resumed() ? undefined : props.task.initialPrompt}
          prefillPrompt={
            props.task.prefillPrompt ??
            (resumed() && !props.task.promptDraft?.trim() ? props.task.initialPrompt : undefined)
          }
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
