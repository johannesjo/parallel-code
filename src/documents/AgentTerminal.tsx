import { For, Show, createMemo, createSignal } from 'solid-js';
import { TerminalView } from '../components/TerminalView';
import { store } from '../store/core';
import { getAgentHookStatus } from '../store/agentHookStatus';
import { updateProject } from '../store/projects';
import type { Project } from '../store/types';
import { documentMainAgentId } from './store';
import { documentAgentPtyId, documentAgentTaskId } from './agent-terminal';
import { setAgentRunning, workspaceUi } from './workspace-ui';

interface AgentTerminalProps {
  project: Project;
}

/**
 * The project's long-running interactive agent, in the app's own terminal.
 * It works in the checkout with the user watching, so its edits show up in the
 * viewer as they land and are committed as manual edits before the next run.
 * The session outlives the workspace: closing and reopening re-attaches.
 */
export function AgentTerminal(props: AgentTerminalProps) {
  const [generation, setGeneration] = createSignal(0);
  const [exited, setExited] = createSignal<number | null | undefined>(undefined);
  const ptyId = () => documentAgentPtyId(props.project.id);
  const agents = createMemo(() => store.availableAgents.filter((a) => a.available !== false));
  const agentId = () => props.project.documentTerminalAgentId ?? documentMainAgentId(props.project);
  const agent = () => agents().find((a) => a.id === agentId()) ?? agents()[0];
  const hook = () => getAgentHookStatus(ptyId());
  const statusLabel = () => {
    if (exited() !== undefined) return `exited (${exited() ?? '?'})`;
    const h = hook();
    if (h?.state === 'waiting') return 'needs you';
    if (h?.state === 'working') return 'working';
    return workspaceUi.agentRunning ? 'idle' : 'starting…';
  };

  // A restart remounts the terminal without attaching: the spawn replaces the
  // live session in one step. Killing first and then attaching would latch
  // the new terminal onto the dying process and show its exit.
  function restart(nextAgentId?: string) {
    setAgentRunning(false);
    setExited(undefined);
    setGeneration((g) => g + 1);
    if (nextAgentId) updateProject(props.project.id, { documentTerminalAgentId: nextAgentId });
  }

  return (
    <div class="docws-agent-pane">
      <div class="docws-agent-head">
        <select
          class="docws-select"
          aria-label="Interactive agent"
          value={agent()?.id}
          onChange={(e) => restart(e.currentTarget.value)}
        >
          <For each={agents()}>{(a) => <option value={a.id}>{a.name}</option>}</For>
        </select>
        <span
          class="docws-agent-status"
          classList={{ 'is-waiting': hook()?.state === 'waiting' && exited() === undefined }}
        >
          {statusLabel()}
        </span>
        <span class="docws-spacer" />
        <button
          type="button"
          class="docws-btn docws-btn-sm"
          title="Stop the session and start a fresh one"
          onClick={() => restart()}
        >
          Restart
        </button>
      </div>
      <Show when={agent()} keyed fallback={<div class="docws-empty">No agent is installed.</div>}>
        {(def) => (
          <div class="docws-agent-term">
            <Show when={`${def.id}:${generation()}`} keyed>
              <TerminalView
                taskId={documentAgentTaskId(props.project.id)}
                agentId={ptyId()}
                command={def.command}
                args={def.args}
                cwd={props.project.path}
                envFile={store.agentEnvFiles[def.id]}
                bookmarksEnabled={false}
                attachExisting={generation() === 0}
                preserveSessionOnCleanup
                fontSize={12}
                onData={() => {
                  if (!workspaceUi.agentRunning) setAgentRunning(true);
                }}
                onExit={(info) => {
                  setAgentRunning(false);
                  setExited(info.exit_code);
                }}
              />
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
