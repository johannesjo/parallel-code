import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { store } from '../store/core';
import {
  dispatchDocumentRun,
  documentMainAgentId,
  documentStore,
  setDocumentMainAgent,
  type DispatchSelection,
  type DocumentSelection,
} from '../store/documents';
import { getProject } from '../store/projects';
import { showNotification } from '../store/notification';
import { errMessage } from '../lib/log';
import {
  MAX_DOCUMENT_CANDIDATES,
  documentAgentSupport,
} from '../../electron/shared/document-agents';
import type { AgentDef } from '../ipc/types';

interface RunComposerProps {
  selection: DocumentSelection;
  /** Offset inside the document container where the composer sits. */
  anchorTop: number;
  onClose: () => void;
}

const MAX_PER_AGENT = 3;

/**
 * The overlay that turns a selection into a run: instruction, agents and
 * candidate counts. The main session is preselected with one candidate so
 * the fast path is select, type, Enter.
 */
export function RunComposer(props: RunComposerProps) {
  let textareaRef: HTMLTextAreaElement | undefined;
  const [instruction, setInstruction] = createSignal('');
  const project = () => (documentStore.projectId ? getProject(documentStore.projectId) : undefined);
  const mainAgentId = () => documentMainAgentId(project());
  const [counts, setCounts] = createSignal<Record<string, number>>({ [mainAgentId()]: 1 });

  const agents = createMemo(() => store.availableAgents);
  const resumable = createMemo(() =>
    agents().filter((a) => a.available !== false && documentAgentSupport(a.id).resume),
  );

  const picks = createMemo<DispatchSelection[]>(() =>
    agents()
      .filter((a) => (counts()[a.id] ?? 0) > 0)
      .map((agent) => ({ agent, count: counts()[agent.id] })),
  );
  const total = createMemo(() => picks().reduce((n, p) => n + p.count, 0));
  const canRun = () =>
    instruction().trim().length > 0 &&
    total() > 0 &&
    total() <= MAX_DOCUMENT_CANDIDATES &&
    !documentStore.dispatching;

  onMount(() => {
    requestAnimationFrame(() => textareaRef?.focus());
  });

  function without(counts: Record<string, number>, id: string): Record<string, number> {
    return Object.fromEntries(Object.entries(counts).filter(([key]) => key !== id));
  }

  function toggleAgent(agent: AgentDef) {
    setCounts((prev) => (prev[agent.id] ? without(prev, agent.id) : { ...prev, [agent.id]: 1 }));
  }

  function bump(agent: AgentDef, e: MouseEvent) {
    e.stopPropagation();
    setCounts((prev) => ({ ...prev, [agent.id]: ((prev[agent.id] ?? 1) % MAX_PER_AGENT) + 1 }));
  }

  async function run() {
    if (!canRun()) return;
    try {
      await dispatchDocumentRun(instruction().trim(), picks());
      props.onClose();
    } catch (err) {
      showNotification(errMessage(err));
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void run();
    }
  }

  const scopeLabel = () => {
    const s = props.selection;
    if (s.wholeDocument) return 'Whole document';
    const lines =
      s.startLine === s.endLine ? `line ${s.startLine}` : `lines ${s.startLine}–${s.endLine}`;
    return s.heading ? `${lines} · ${s.heading}` : lines;
  };

  return (
    <div
      class="docws-composer"
      role="dialog"
      aria-label="Run a task on the selected passage"
      style={{ top: `${props.anchorTop}px` }}
      onKeyDown={handleKeyDown}
      onMouseUp={(e) => e.stopPropagation()}
    >
      <div class="docws-composer-footer">
        <span>{scopeLabel()}</span>
        <span class="docws-spacer" />
        <label>
          Main session{' '}
          <select
            class="docws-select"
            value={mainAgentId()}
            onChange={(e) => {
              const next = e.currentTarget.value;
              const prevMain = mainAgentId();
              setDocumentMainAgent(next);
              setCounts((prev) =>
                prev[prevMain] && !prev[next]
                  ? { ...without(prev, prevMain), [next]: prev[prevMain] }
                  : prev,
              );
            }}
          >
            <For each={resumable()}>{(a) => <option value={a.id}>{a.name}</option>}</For>
          </select>
        </label>
      </div>
      <Show when={!props.selection.wholeDocument}>
        <div class="docws-composer-quote">{props.selection.quote.slice(0, 400)}</div>
      </Show>
      <textarea
        ref={textareaRef}
        placeholder="What should change here? e.g. find a simpler architecture, challenge these assumptions…"
        value={instruction()}
        onInput={(e) => setInstruction(e.currentTarget.value)}
      />
      <div class="docws-agent-row" role="group" aria-label="Agents">
        <For each={agents()}>
          {(agent) => {
            const support = documentAgentSupport(agent.id);
            const enabled = () => support.headless && agent.available !== false;
            const count = () => counts()[agent.id] ?? 0;
            const title = () =>
              !support.headless
                ? 'No headless mode known for this agent'
                : agent.available === false
                  ? 'Not installed'
                  : agent.id === mainAgentId()
                    ? 'Main session (resumes previous context)'
                    : 'One-shot alternate';
            return (
              <button
                type="button"
                class="docws-agent-chip"
                aria-pressed={count() > 0}
                disabled={!enabled()}
                title={title()}
                onClick={() => toggleAgent(agent)}
              >
                {agent.name}
                <Show when={agent.id === mainAgentId() && support.resume}>
                  <span class="docws-main-badge">main</span>
                </Show>
                <Show when={count() > 0}>
                  <span
                    class="docws-count-btn"
                    role="button"
                    title="Candidates from this agent (click to change)"
                    onClick={(e) => bump(agent, e)}
                  >
                    ×{count()}
                  </span>
                </Show>
              </button>
            );
          }}
        </For>
      </div>
      <div class="docws-composer-footer">
        <span>
          {total()} candidate{total() === 1 ? '' : 's'}
          {total() > 1 ? ' · opens the compare view' : ''}
          {total() > MAX_DOCUMENT_CANDIDATES ? ` · max ${MAX_DOCUMENT_CANDIDATES}` : ''}
        </span>
        <span class="docws-spacer" />
        <span>Enter to run · Esc to close</span>
        <button type="button" class="docws-btn docws-btn-sm" onClick={() => props.onClose()}>
          Cancel
        </button>
        <button
          type="button"
          class="docws-btn docws-btn-sm docws-btn-primary"
          disabled={!canRun()}
          onClick={() => void run()}
        >
          {documentStore.dispatching ? 'Starting…' : 'Run'}
        </button>
      </div>
    </div>
  );
}
