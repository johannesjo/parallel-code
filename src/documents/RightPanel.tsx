import { For, Show, createMemo } from 'solid-js';
import type { Project } from '../store/types';
import {
  activeDocumentPath,
  documentStore,
  openDocumentCompare,
  reviewableRuns,
  setDocumentView,
  setShowResolvedAnnotations,
} from './store';
import { focusAnnotation, setRailTab, workspaceUi } from './workspace-ui';
import { isDocumentAgentWaiting } from './agent-task';
import { AgentTerminal } from './AgentTerminal';
import { RunsRail } from './RunsRail';
import { RejectRunButton } from './RejectRunConfirm';
import { DiffIcon } from '../components/icons';

interface RightPanelProps {
  project: Project;
  visible?: boolean;
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
                  <DiffIcon size={12} />
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
 * document's comments, one tab each. Runs that wait for a decision are shown over
 * the agent too, so nothing sits unnoticed behind a tab that is not up.
 */
export function RightPanel(props: RightPanelProps) {
  const notes = () =>
    documentStore.annotations.filter(
      (a) => a.anchor.path === activeDocumentPath() && (!a.resolved || documentStore.showResolved),
    );
  const decisions = () => reviewableRuns().length;
  const running = () =>
    documentStore.runOrder.filter((id) => documentStore.runs[id]?.status === 'running').length;
  // Claude says so through its hooks; for the rest the terminal output has to tell.
  const agentWaiting = () => isDocumentAgentWaiting(props.project.id);
  const runsLabel = () => {
    if (decisions() > 0) return `Runs, ${decisions()} awaiting a decision`;
    if (running() > 0) return `Runs, ${running()} running`;
    return 'Runs';
  };

  return (
    <aside class="docws-rail" aria-label="Agent, runs and comments" inert={props.visible === false}>
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
          aria-selected={workspaceUi.railTab === 'notes'}
          onClick={() => setRailTab('notes')}
        >
          Comments
        </button>
      </div>
      <div class="docws-agent-tab" classList={{ 'is-hidden': workspaceUi.railTab !== 'agent' }}>
        <DecisionStrip />
        <AgentTerminal
          project={props.project}
          visible={props.visible !== false && workspaceUi.railTab === 'agent'}
        />
      </div>
      <Show when={workspaceUi.railTab === 'runs'}>
        <div class="docws-rail-list">
          <RunsRail />
        </div>
      </Show>
      <Show when={workspaceUi.railTab === 'notes'}>
        <div class="docws-rail-list" aria-label="Document comments">
          <label class="docws-toggle docws-notes-filter">
            <input
              type="checkbox"
              checked={documentStore.showResolved}
              onChange={(e) => setShowResolvedAnnotations(e.currentTarget.checked)}
            />
            Show resolved
          </label>
          <Show when={notes().length === 0}>
            <div class="docws-empty">
              Select a passage and choose Comment to add your thoughts. No agent needed.
            </div>
          </Show>
          <For each={notes()}>
            {(note) => (
              <button
                type="button"
                class="docws-note-entry"
                onClick={() => {
                  setDocumentView('document');
                  focusAnnotation(note.id);
                }}
              >
                <span class="docws-history-meta">
                  {note.kind === 'note' ? 'Comment' : 'Question'}
                  {note.resolved ? ' · Resolved' : ''}
                </span>
                <span class="docws-note-entry-quote">{note.anchor.quote.slice(0, 160)}</span>
                <span>{note.text}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </aside>
  );
}
