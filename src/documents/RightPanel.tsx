import { For, Show, createMemo } from 'solid-js';
import { store } from '../store/core';
import type { Project } from '../store/types';
import { getAgentHookStatus } from '../store/agentHookStatus';
import { isAgentAskingQuestion } from '../store/taskStatus';
import { documentStore, openDocumentCompare, reviewableRuns } from './store';
import { setRailTab, workspaceUi } from './workspace-ui';
import { documentAgentTaskId } from './agent-task';
import { AgentTerminal } from './AgentTerminal';
import { RunsRail } from './RunsRail';
import { FileTreePanel } from './FileTreePanel';
import { RejectRunButton } from './RejectRunConfirm';

interface RightPanelProps {
  project: Project;
}

/** Finished runs with proposals nobody has accepted or rejected yet. */
function DecisionStrip() {
  const pending = createMemo(() => reviewableRuns());
  return (
    <Show when={pending().length > 0}>
      <div class="docws-decisions" role="region" aria-label="Runs awaiting a decision">
        <For each={pending()}>
          {(run) => {
            const proposals = () => run.candidates.filter((c) => c.commitSha).length;
            return (
              <div class="docws-decision">
                <span class="docws-decision-text" title={run.instruction}>
                  {run.instruction}
                </span>
                <button
                  type="button"
                  class="docws-btn docws-btn-sm docws-btn-primary"
                  onClick={() => openDocumentCompare(run.id)}
                >
                  {proposals() > 1 ? `Compare ${proposals()}` : 'Review'}
                </button>
                <RejectRunButton run={run} label="Reject" />
              </div>
            );
          }}
        </For>
      </div>
    </Show>
  );
}

/**
 * The right-hand task section: the interactive agent, the one-shot runs and the
 * project's files, one tab each. Runs that wait for a decision are shown over
 * the agent too, so nothing sits unnoticed behind a tab that is not up.
 */
export function RightPanel(props: RightPanelProps) {
  const decisions = () => reviewableRuns().length;
  const running = () =>
    documentStore.runOrder.filter((id) => documentStore.runs[id]?.status === 'running').length;
  const agentIds = () => store.tasks[documentAgentTaskId(props.project.id)]?.agentIds ?? [];
  // Claude says so through its hooks; for the rest the terminal output has to tell.
  const agentWaiting = () =>
    agentIds().some(
      (id) => getAgentHookStatus(id)?.state === 'waiting' || isAgentAskingQuestion(id),
    );
  const runsLabel = () => {
    if (decisions() > 0) return `Runs, ${decisions()} awaiting a decision`;
    if (running() > 0) return `Runs, ${running()} running`;
    return 'Runs';
  };

  return (
    <aside class="docws-rail" aria-label="Agent, runs and files">
      <div class="docws-rail-tabs docws-tabs" role="tablist">
        <button
          type="button"
          class="docws-tab"
          role="tab"
          aria-selected={workspaceUi.railTab === 'agent'}
          aria-label={agentWaiting() ? 'Agent, waiting for you' : 'Agent'}
          onClick={() => setRailTab('agent')}
        >
          Agent
          <Show when={agentWaiting()}>
            <span
              class="docws-count is-attention"
              title="The agent is waiting for you"
              aria-hidden="true"
            >
              !
            </span>
          </Show>
        </button>
        <button
          type="button"
          class="docws-tab"
          role="tab"
          aria-selected={workspaceUi.railTab === 'runs'}
          aria-label={runsLabel()}
          onClick={() => setRailTab('runs')}
        >
          Runs
          <Show when={decisions() + running() > 0}>
            <span
              class="docws-count"
              classList={{ 'is-attention': decisions() > 0 }}
              aria-hidden="true"
            >
              {decisions() > 0 ? decisions() : running()}
            </span>
          </Show>
        </button>
        <button
          type="button"
          class="docws-tab"
          role="tab"
          aria-selected={workspaceUi.railTab === 'files'}
          onClick={() => setRailTab('files')}
        >
          Files
        </button>
      </div>
      <div class="docws-agent-tab" classList={{ 'is-hidden': workspaceUi.railTab !== 'agent' }}>
        <DecisionStrip />
        <AgentTerminal project={props.project} visible={workspaceUi.railTab === 'agent'} />
      </div>
      <Show when={workspaceUi.railTab === 'runs'}>
        <div class="docws-rail-list">
          <RunsRail />
        </div>
      </Show>
      <Show when={workspaceUi.railTab === 'files'}>
        <FileTreePanel projectRoot={props.project.path} />
      </Show>
    </aside>
  );
}
