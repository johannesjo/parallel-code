import { For, Show, createMemo, createSignal, onMount, untrack } from 'solid-js';
import { store } from '../store/core';
import {
  addDocumentAnnotation,
  dispatchDocumentRun,
  documentMainAgentId,
  documentStore,
  setDocumentMainAgent,
  type DispatchSelection,
  type DocumentSelection,
} from '../store/documents';
import { createAnchor } from '../lib/annotation-anchor';
import type { DocumentBlock } from '../lib/markdown-blocks';
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
  /** Current blocks, for anchoring an annotation to the selection. */
  blocks: DocumentBlock[];
  /** Offset inside the document container where the composer sits. */
  anchorTop: number;
  onClose: () => void;
}

type ComposerMode = 'task' | 'note' | 'question';

const MAX_PER_AGENT = 3;

/**
 * The overlay that turns a selection into a run: instruction, agents and
 * candidate counts. The main session is preselected with one candidate so
 * the fast path is select, type, Enter.
 */
export function RunComposer(props: RunComposerProps) {
  let textareaRef: HTMLTextAreaElement | undefined;
  const draft = untrack(() => documentStore.composerDraft);
  const [instruction, setInstruction] = createSignal(draft?.text ?? '');
  const [mode, setMode] = createSignal<ComposerMode>('task');
  const [saving, setSaving] = createSignal(false);
  const project = () => (documentStore.projectId ? getProject(documentStore.projectId) : undefined);
  const mainAgentId = () => documentMainAgentId(project());
  const [counts, setCounts] = createSignal<Record<string, number>>({ [mainAgentId()]: 1 });
  const [askAgentId, setAskAgentId] = createSignal(mainAgentId());

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
  const canAnnotate = () =>
    instruction().trim().length > 0 && !props.selection.wholeDocument && !saving();
  const askAgent = () => agents().find((a) => a.id === askAgentId()) ?? resumable()[0];

  /** Notes and questions never touch the document: they are saved beside it. */
  async function annotate() {
    if (!canAnnotate()) return;
    setSaving(true);
    try {
      const anchor = createAnchor(
        props.blocks,
        props.selection.startBlock,
        props.selection.endBlock,
        project()?.documentPath ?? '',
        documentStore.snapshot?.headSha ?? null,
      );
      const saved = await addDocumentAnnotation(
        mode() === 'question' ? 'question' : 'note',
        instruction().trim(),
        anchor,
        mode() === 'question' ? askAgent() : undefined,
      );
      if (saved) props.onClose();
    } finally {
      setSaving(false);
    }
  }

  function submit() {
    if (mode() === 'task') void run();
    else void annotate();
  }

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
      submit();
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
        <span class="docws-mode-tabs" role="tablist" aria-label="What to do with the passage">
          <button
            type="button"
            class="docws-tab"
            role="tab"
            aria-selected={mode() === 'task'}
            onClick={() => setMode('task')}
          >
            Task
          </button>
          <button
            type="button"
            class="docws-tab"
            role="tab"
            aria-selected={mode() === 'note'}
            disabled={props.selection.wholeDocument}
            title={
              props.selection.wholeDocument
                ? 'Notes attach to a passage, not the whole document'
                : 'Write a note beside this passage'
            }
            onClick={() => setMode('note')}
          >
            Note
          </button>
          <button
            type="button"
            class="docws-tab"
            role="tab"
            aria-selected={mode() === 'question'}
            disabled={props.selection.wholeDocument}
            title={
              props.selection.wholeDocument
                ? 'Questions attach to a passage, not the whole document'
                : 'Ask an agent about this passage; the answer goes into a bubble'
            }
            onClick={() => setMode('question')}
          >
            Ask
          </button>
        </span>
        <span>{scopeLabel()}</span>
        <span class="docws-spacer" />
        <label style={{ display: mode() === 'task' ? undefined : 'none' }}>
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
        placeholder={
          mode() === 'task'
            ? 'What should change here? e.g. find a simpler architecture, challenge these assumptions…'
            : mode() === 'note'
              ? 'A note to yourself about this passage. It never changes the document.'
              : 'A question about this passage. The answer lands in a bubble, not in the document.'
        }
        value={instruction()}
        onInput={(e) => setInstruction(e.currentTarget.value)}
      />
      <Show when={mode() === 'question'}>
        <div class="docws-agent-row" role="radiogroup" aria-label="Agent to ask">
          <For each={agents().filter((a) => documentAgentSupport(a.id).headless)}>
            {(agent) => (
              <button
                type="button"
                class="docws-agent-chip"
                role="radio"
                aria-checked={askAgent()?.id === agent.id}
                aria-pressed={askAgent()?.id === agent.id}
                disabled={agent.available === false}
                title={
                  agent.available === false ? 'Not installed' : 'Reads the document, cannot edit it'
                }
                onClick={() => setAskAgentId(agent.id)}
              >
                {agent.name}
              </button>
            )}
          </For>
        </div>
      </Show>
      <div
        class="docws-agent-row"
        role="group"
        aria-label="Agents"
        style={{ display: mode() === 'task' ? undefined : 'none' }}
      >
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
        <Show
          when={mode() === 'task'}
          fallback={<span>Saved beside the document, never into it</span>}
        >
          <span>
            {total()} candidate{total() === 1 ? '' : 's'}
            {total() > 1 ? ' · opens the compare view' : ''}
            {total() > MAX_DOCUMENT_CANDIDATES ? ` · max ${MAX_DOCUMENT_CANDIDATES}` : ''}
          </span>
        </Show>
        <span class="docws-spacer" />
        <span>
          Enter to {mode() === 'task' ? 'run' : mode() === 'note' ? 'save' : 'ask'} · Esc to close
        </span>
        <button type="button" class="docws-btn docws-btn-sm" onClick={() => props.onClose()}>
          Cancel
        </button>
        <Show
          when={mode() === 'task'}
          fallback={
            <button
              type="button"
              class="docws-btn docws-btn-sm docws-btn-primary"
              disabled={!canAnnotate()}
              onClick={() => void annotate()}
            >
              {saving() ? 'Saving…' : mode() === 'note' ? 'Save note' : 'Ask'}
            </button>
          }
        >
          <button
            type="button"
            class="docws-btn docws-btn-sm docws-btn-primary"
            disabled={!canRun()}
            onClick={() => void run()}
          >
            {documentStore.dispatching ? 'Starting…' : 'Run'}
          </button>
        </Show>
      </div>
    </div>
  );
}
