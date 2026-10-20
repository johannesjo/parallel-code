import { Show, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import { TaskAITerminal } from './TaskAITerminal';
import { PromptInput } from './PromptInput';
import { setStore, store } from '../store/core';
import { effectiveAgentId } from '../store/agent-select';
import { setActiveAgent } from '../store/navigation';
import { setTaskFocusedPanel } from '../store/focused-panel';
import { clearInitialPrompt, clearPrefillPrompt } from '../store/tasks';
import { rearmDocumentAgents } from '../documents/agent-task';
import type { Task } from '../store/types';
import './hidden-agent-pane.css';

interface HiddenAgentPaneProps {
  task: Task | undefined;
  visible: boolean;
  fallback: JSX.Element;
  /** Returns true when the path was handled; otherwise the terminal's viewer opens it. */
  onFileLink?: (filePath: string) => boolean;
  /** Defaults to selecting the agent of the active task. */
  onSelectAgent?: (agentId: string) => void;
}

/**
 * A hidden task's terminal, agent chips and prompt box, as a task panel shows
 * them. The sessions outlive the pane: unmounting and mounting re-attaches.
 */
export function HiddenAgentPane(props: HiddenAgentPaneProps) {
  // Keyed so children get the task record itself. A non-keyed accessor
  // re-reads the project through the rail's <Show> on every access, and
  // TaskAITerminal reads the task id from its cleanups: on close that read
  // hits a memo already marked pending, which re-enters the disposal and
  // crashes inside Solid.
  return (
    <div class="docws-agent-pane">
      <Show when={props.task} keyed fallback={props.fallback}>
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
          return (
            <AgentTask
              task={t}
              visible={props.visible}
              onFileLink={props.onFileLink}
              onSelectAgent={props.onSelectAgent ?? setActiveAgent}
            />
          );
        }}
      </Show>
    </div>
  );
}

function AgentTask(props: {
  task: Task;
  visible: boolean;
  onFileLink?: (filePath: string) => boolean;
  onSelectAgent: (agentId: string) => void;
}) {
  const resumed = () => store.agents[props.task.agentIds[0]]?.resumed === true;
  return (
    <>
      <div class="docws-agent-term">
        <TaskAITerminal
          task={props.task}
          isActive={store.activeTaskId === props.task.id}
          visible={props.visible}
          selectedAgentId={effectiveAgentId(props.task) ?? ''}
          onSelectAgent={props.onSelectAgent}
          onFileLink={props.onFileLink}
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
