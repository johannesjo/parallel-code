import { For, Show, createEffect, createMemo, createSignal, on, untrack } from 'solid-js';
import { store } from '../store/core';
import {
  activeDocumentPath,
  addDocumentAnnotation,
  buildCandidateSpecs,
  dispatchDocumentRun,
  documentMainAgentId,
  documentModelChoices,
  documentStore,
  setDocumentMainAgent,
  setDocumentModelChoice,
  withModelChoice,
  type ComposerMode,
  type DispatchSelection,
  type DocumentSelection,
} from './store';
import { createAnchor } from './annotation-anchor';
import type { DocumentBlock } from './markdown-blocks';
import { getProject } from '../store/projects';
import { showNotification } from '../store/notification';
import { errMessage } from '../lib/log';
import { MAX_DOCUMENT_CANDIDATES, documentAgentSupport } from '../../electron/documents/shared';
import type { AgentDef } from '../ipc/types';
import type { DocumentModelChoice } from '../store/types';
import { ModelRows, type ChoiceSlot, type ModelSlot } from './ModelRows';
import { buildInteractivePrompt } from './interactive-prompt';
import { sendToDocumentAgent } from './agent-task';
import { ActionIcon } from './BlockActions';

interface RunComposerProps {
  /** The picked passage; null means the whole document. */
  selection: DocumentSelection | null;
  /** Current blocks, for anchoring an annotation to the selection. */
  blocks: DocumentBlock[];
  onClose: () => void;
}

const MAX_PER_AGENT = 3;

function wholeDocumentSelection(blocks: DocumentBlock[]): DocumentSelection {
  const last = blocks[blocks.length - 1];
  return {
    startBlock: 0,
    endBlock: Math.max(0, blocks.length - 1),
    startLine: blocks[0]?.startLine ?? 1,
    endLine: last?.endLine ?? 1,
    quote: '',
    heading: undefined,
    wholeDocument: true,
  };
}

/**
 * The popover that turns a passage into work: a task for the interactive
 * session or for one-shot candidates, a note, or a question. It opens over
 * the prose when a passage is picked or a task on the whole document is asked
 * for, and goes away once the work is handed off or dismissed. The main
 * session is preselected with one candidate so the fast path is select, type,
 * Enter.
 */
export function RunComposer(props: RunComposerProps) {
  let textareaRef: HTMLTextAreaElement | undefined;
  const draft = untrack(() => documentStore.composerDraft);
  const [instruction, setInstruction] = createSignal(draft?.text ?? '');
  const [mode, setMode] = createSignal<ComposerMode>('proposals');
  // Task and proposals are one instruction with two destinations: the agent's
  // session, or headless candidates. They share the textarea and the placeholder.
  const isTask = () => mode() === 'task' || mode() === 'proposals';
  const oneshot = () => mode() === 'proposals';
  const [saving, setSaving] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  // Just opened on a passage: shown at full strength until focus leaves it.
  const [fresh, setFresh] = createSignal(false);
  let rootRef: HTMLDivElement | undefined;
  const selection = (): DocumentSelection =>
    props.selection ?? wholeDocumentSelection(props.blocks);
  const hasPassage = () => !!props.selection && !props.selection.wholeDocument;
  const project = () => (documentStore.projectId ? getProject(documentStore.projectId) : undefined);
  const mainAgentId = () => documentMainAgentId(project());
  // Preselecting an agent that is not installed would only fail on dispatch.
  const [counts, setCounts] = createSignal<Record<string, number>>(
    untrack(() => {
      const id = mainAgentId();
      const main = store.availableAgents.find((a) => a.id === id);
      return main && main.available !== false ? { [id]: 1 } : {};
    }),
  );
  const [askAgentId, setAskAgentId] = createSignal(mainAgentId());
  // Starts from the project's last choices per agent and candidate slot, and
  // is remembered as it changes.
  const [choices, setChoices] = createSignal<Record<string, DocumentModelChoice[]>>(
    untrack(() => {
      const p = project();
      const ids = Object.keys(p?.documentModels ?? {});
      return Object.fromEntries(ids.map((id) => [id, documentModelChoices(p, id)]));
    }),
  );
  const choice = (slot: ChoiceSlot): DocumentModelChoice =>
    choices()[slot.agentId]?.[slot.index] ?? {};

  const agents = createMemo(() => store.availableAgents);
  const resumable = createMemo(() =>
    agents().filter((a) => a.available !== false && documentAgentSupport(a.id).resume),
  );

  // Agents and counts alone: the model rows key off this, so typing a model
  // name does not rebuild them.
  const layout = createMemo(() =>
    agents()
      .filter((a) => (counts()[a.id] ?? 0) > 0)
      .map((agent) => ({ agent, count: counts()[agent.id] })),
  );
  const picks = (): DispatchSelection[] =>
    layout().map((pick) => ({ ...pick, choices: choices()[pick.agent.id] ?? [] }));
  // The same specs dispatch will build, so labels and the main badge match the rail.
  const slots = createMemo<ModelSlot[]>(() => {
    const p = project();
    if (!p) return [];
    const seen = new Map<string, number>();
    return buildCandidateSpecs(p, layout(), {}).map((spec) => {
      const index = seen.get(spec.agentId) ?? 0;
      seen.set(spec.agentId, index + 1);
      return { spec, agentId: spec.agentId, index };
    });
  });
  const total = createMemo(() => picks().reduce((n, p) => n + p.count, 0));
  const canRun = () =>
    instruction().trim().length > 0 &&
    total() > 0 &&
    total() <= MAX_DOCUMENT_CANDIDATES &&
    !documentStore.dispatching;
  const canAnnotate = () => instruction().trim().length > 0 && hasPassage() && !saving();
  const installed = createMemo(() => agents().filter((a) => a.available !== false));
  const canSend = () =>
    instruction().trim().length > 0 && !!project() && installed().length > 0 && !sending();
  const askAgent = () => agents().find((a) => a.id === askAgentId()) ?? resumable()[0];

  /** Notes and questions never touch the document: they are saved beside it. */
  async function annotate() {
    if (!canAnnotate()) return;
    setSaving(true);
    try {
      const s = selection();
      const anchor = createAnchor(
        props.blocks,
        s.startBlock,
        s.endBlock,
        activeDocumentPath() ?? project()?.documentPath ?? '',
        documentStore.snapshot?.headSha ?? null,
      );
      const saved = await addDocumentAnnotation(
        mode() === 'question' ? 'question' : 'note',
        instruction().trim(),
        anchor,
        mode() === 'question' ? { askWith: askAgent() } : {},
      );
      if (saved) finish();
    } finally {
      setSaving(false);
    }
  }

  function submit() {
    if (!isTask()) void annotate();
    else if (oneshot()) void run();
    else void send();
  }

  // Picking a passage or turning a bubble into a task brings the cursor here.
  // The pane scrolls the passage into view; a focus scroll would fight it.
  // The store merges a new selection into the old object, so track the range.
  const pickedRange = () =>
    props.selection ? `${props.selection.startBlock}-${props.selection.endBlock}` : null;
  createEffect(
    on(
      () => [pickedRange(), documentStore.composerDraft] as const,
      ([range, d]) => {
        if (!range && !d) {
          setFresh(false);
          return;
        }
        if (d?.text) setInstruction(d.text);
        if (d?.mode) setMode(d.mode);
        setFresh(true);
        requestAnimationFrame(() => textareaRef?.focus({ preventScroll: true }));
      },
    ),
  );

  function handleFocusOut(e: FocusEvent) {
    if (!rootRef?.contains(e.relatedTarget as Node | null)) setFresh(false);
  }

  function without(counts: Record<string, number>, id: string): Record<string, number> {
    return Object.fromEntries(Object.entries(counts).filter(([key]) => key !== id));
  }

  function toggleAgent(agent: AgentDef) {
    setCounts((prev) => (prev[agent.id] ? without(prev, agent.id) : { ...prev, [agent.id]: 1 }));
  }

  function setChoice(slot: ChoiceSlot, patch: DocumentModelChoice, persist: boolean) {
    const merged = { ...choice(slot), ...patch };
    const next: DocumentModelChoice = {};
    if (merged.model?.trim()) next.model = merged.model.trim();
    if (merged.effort) next.effort = merged.effort;
    setChoices((prev) => ({
      ...prev,
      [slot.agentId]: withModelChoice(prev[slot.agentId] ?? [], slot.index, next),
    }));
    if (persist) setDocumentModelChoice(slot.agentId, slot.index, next);
  }

  function bump(agent: AgentDef, e: MouseEvent) {
    e.stopPropagation();
    setCounts((prev) => ({ ...prev, [agent.id]: ((prev[agent.id] ?? 1) % MAX_PER_AGENT) + 1 }));
  }

  async function run() {
    if (!canRun()) return;
    try {
      await dispatchDocumentRun(instruction().trim(), picks(), selection());
      finish();
    } catch (err) {
      showNotification(errMessage(err));
    }
  }

  /** Types the scoped instruction into the interactive session on the right. */
  async function send() {
    const p = project();
    if (!canSend() || !p) return;
    const text = buildInteractivePrompt(
      activeDocumentPath() ?? p.documentPath ?? '',
      selection(),
      instruction(),
    );
    // A second Enter while the first is still typing into the terminal would
    // send the instruction twice.
    setSending(true);
    try {
      await sendToDocumentAgent(p, text);
      finish();
    } catch (err) {
      showNotification(errMessage(err));
    } finally {
      setSending(false);
    }
  }

  /** Work was handed off: clear the draft and the passage, keep the popover. */
  function finish() {
    setInstruction('');
    props.onClose();
  }

  function handleKeyDown(e: KeyboardEvent) {
    // Enter and Escape mid-composition belong to the IME (229 is the legacy signal).
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
      textareaRef?.blur();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // The task terminal underneath treats Enter as its send shortcut.
      e.stopPropagation();
      submit();
    }
  }

  const verb = () => {
    if (mode() === 'note') return 'save';
    if (mode() === 'question') return 'ask';
    return oneshot() ? 'run' : 'send';
  };
  const keys = () => `Enter to ${verb()} · Esc to clear`;

  /** What the chosen mode does with the passage, said once beside the button. */
  const hint = () => {
    if (!isTask()) return 'Saved beside the document, never into it';
    if (!oneshot()) return 'The agent edits your document directly.';
    const cap = total() > MAX_DOCUMENT_CANDIDATES ? ` · max ${MAX_DOCUMENT_CANDIDATES}` : '';
    return `Your document changes only when you accept a proposal.${cap}`;
  };

  const scopeLabel = () => {
    const s = selection();
    if (s.wholeDocument) return 'Whole document';
    const lines =
      s.startLine === s.endLine ? `line ${s.startLine}` : `lines ${s.startLine}–${s.endLine}`;
    return s.heading ? `${lines} · ${s.heading}` : lines;
  };

  return (
    <div
      ref={rootRef}
      class="docws-composer"
      role="dialog"
      aria-label="Work on the selected passage"
      classList={{ 'is-scoped': hasPassage(), 'is-fresh': fresh() }}
      onFocusOut={handleFocusOut}
    >
      <div class="docws-composer-head">
        <span class="docws-mode-tabs" role="tablist" aria-label="What to do with the passage">
          <button
            type="button"
            class="docws-tab"
            role="tab"
            aria-selected={mode() === 'task'}
            title="The agent edits your document directly"
            onClick={() => setMode('task')}
          >
            <ActionIcon kind="task" />
            Edit with agent
          </button>
          <button
            type="button"
            class="docws-tab"
            role="tab"
            aria-selected={mode() === 'proposals'}
            title="Agents draft candidates; review them before accepting"
            onClick={() => setMode('proposals')}
          >
            <ActionIcon kind="proposals" />
            Proposals
          </button>
          <button
            type="button"
            class="docws-tab"
            role="tab"
            aria-selected={mode() === 'note'}
            disabled={!hasPassage()}
            title={
              !hasPassage()
                ? 'Notes attach to a passage: pick one first'
                : 'Write a note beside this passage'
            }
            onClick={() => setMode('note')}
          >
            <ActionIcon kind="note" />
            Note
          </button>
          <button
            type="button"
            class="docws-tab"
            role="tab"
            aria-selected={mode() === 'question'}
            disabled={!hasPassage()}
            title={
              !hasPassage()
                ? 'Questions attach to a passage: pick one first'
                : 'Ask an agent about this passage; the answer goes into a bubble'
            }
            onClick={() => setMode('question')}
          >
            <ActionIcon kind="question" />
            Ask
          </button>
        </span>
        <span class="docws-composer-scope" title={scopeLabel()}>
          {scopeLabel()}
        </span>
        <button
          type="button"
          class="docws-composer-close"
          aria-label={hasPassage() ? 'Clear the passage' : 'Close'}
          title={hasPassage() ? 'Let go of the passage and close · Esc' : 'Close · Esc'}
          onClick={() => props.onClose()}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
          </svg>
        </button>
      </div>
      <Show when={hasPassage()}>
        <div class="docws-composer-quote">{selection().quote.slice(0, 400)}</div>
      </Show>
      <textarea
        ref={textareaRef}
        aria-label="Instruction"
        onKeyDown={handleKeyDown}
        placeholder={
          isTask()
            ? hasPassage()
              ? 'What should change here? e.g. find a simpler architecture, challenge these assumptions…'
              : 'What should change in this document? Pick a passage to narrow it down.'
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
      {/* Proposals: who drafts them is the decision, so the agents are in
          plain view; model and main-session tuning sits one click away. */}
      <Show when={oneshot()}>
        <div class="docws-proposal-panel">
          <div class="docws-proposal-head">
            <span
              class="docws-proposal-count"
              classList={{ 'is-over': total() > MAX_DOCUMENT_CANDIDATES }}
            >
              {total()} of {MAX_DOCUMENT_CANDIDATES} candidates
            </span>
            <span class="docws-composer-hint">
              Click an agent to add or drop it, its count to draft more than once.
            </span>
          </div>
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
                  <div class="docws-agent-pick" classList={{ 'is-on': count() > 0 }}>
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
                    </button>
                    <Show when={count() > 0}>
                      <button
                        type="button"
                        class="docws-count-btn"
                        aria-label={`Candidates from ${agent.name}: ${count()}`}
                        title={`${count()} candidate${count() === 1 ? '' : 's'} from this agent · click for ${(count() % MAX_PER_AGENT) + 1}`}
                        onClick={(e) => bump(agent, e)}
                      >
                        ×{count()}
                      </button>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
          <details class="docws-proposal-options">
            <summary>Models and main session</summary>
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
            <Show when={slots().length > 0}>
              <ModelRows slots={slots()} choice={choice} onChoice={setChoice} />
            </Show>
          </details>
        </div>
      </Show>
      <div class="docws-composer-footer">
        <span class="docws-composer-hint">{hint()}</span>
        <span>{keys()}</span>
        <Show
          when={isTask()}
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
          <Show
            when={oneshot()}
            fallback={
              <button
                type="button"
                class="docws-btn docws-btn-sm docws-btn-primary"
                disabled={!canSend()}
                title={installed().length === 0 ? 'No agent is installed.' : undefined}
                onClick={() => void send()}
              >
                Send to agent
              </button>
            }
          >
            <button
              type="button"
              class="docws-btn docws-btn-sm docws-btn-primary"
              disabled={!canRun()}
              onClick={() => void run()}
            >
              {documentStore.dispatching ? 'Starting…' : 'Generate proposals'}
            </button>
          </Show>
        </Show>
      </div>
    </div>
  );
}
