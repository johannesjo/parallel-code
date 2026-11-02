import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  untrack,
} from 'solid-js';
import { store } from '../store/core';
import {
  activeDocumentPath,
  addDocumentAnnotation,
  saveDocumentNoteDraft,
  buildCandidateSpecs,
  dispatchDocumentRun,
  documentMainAgentId,
  documentModelChoices,
  documentStore,
  setDocumentMainAgent,
  setDocumentComposerDraft,
  setDocumentModelChoice,
  withModelChoice,
  type ComposerMode,
  type DispatchSelection,
  type DocumentSelection,
} from './store';
import { createAnchor } from './annotation-anchor';
import { afterPress, onScrollbar } from './press';
import type { DocumentBlock } from './markdown-blocks';
import { getProject } from '../store/projects';
import { showNotification } from '../store/notification';
import { errMessage } from '../lib/log';
import { focusAnnotation, setRailTab } from './workspace-ui';
import { MAX_DOCUMENT_CANDIDATES, documentAgentSupport } from '../../electron/documents/shared';
import type { AgentDef } from '../ipc/types';
import type { DocumentModelChoice } from '../store/types';
import { ModelRows, type ChoiceSlot, type ModelSlot } from './ModelRows';
import { buildInteractivePrompt } from './interactive-prompt';
import { sendToDocumentAgent } from './agent-task';
import { CloseIcon, SendIcon, SparkleIcon } from '../components/icons';

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

/** Opens only after a passage action, with one reviewed suggestion as the default. */
export function RunComposer(props: RunComposerProps) {
  let textareaRef: HTMLTextAreaElement | undefined;
  const draft = untrack(() => documentStore.composerDraft);
  const [instruction, setInstruction] = createSignal(draft?.text ?? '');
  const [mode, setMode] = createSignal<ComposerMode>(draft?.mode ?? 'proposals');
  const [compare, setCompare] = createSignal(false);
  // Task and proposals are one instruction with two destinations: the agent's
  // session, or headless candidates. They share the textarea and the placeholder.
  const isTask = () => mode() === 'task' || mode() === 'proposals';
  const oneshot = () => mode() === 'proposals';
  const [saving, setSaving] = createSignal(false);
  const noteSaving = () =>
    mode() === 'note' && documentStore.composerDraft?.noteSaveStatus === 'saving';
  const noteSaveFailed = () =>
    mode() === 'note' && documentStore.composerDraft?.noteSaveStatus === 'error';
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

  const [singleAgentId, setSingleAgentId] = createSignal(mainAgentId());
  const singleAgent = () =>
    agents().find(
      (a) =>
        a.id === singleAgentId() && a.available !== false && documentAgentSupport(a.id).headless,
    ) ?? agents().find((a) => a.available !== false && documentAgentSupport(a.id).headless);

  function singlePicks() {
    const agent = singleAgent();
    return agent ? [{ agent, count: 1 }] : [];
  }

  // Agents and counts alone: the model rows key off this, so typing a model
  // name does not rebuild them.
  const layout = createMemo(() =>
    compare()
      ? agents()
          .filter(
            (a) =>
              (counts()[a.id] ?? 0) > 0 &&
              a.available !== false &&
              documentAgentSupport(a.id).headless,
          )
          .map((agent) => ({ agent, count: counts()[agent.id] }))
      : singlePicks(),
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
  // The count on the control follows the real candidate total, so a tweak made
  // in Options is reflected rather than contradicted.
  const alternatives = () => (compare() ? Math.min(Math.max(total(), 1), 3) : 1);
  const canRun = () =>
    instruction().trim().length > 0 &&
    total() > 0 &&
    total() <= MAX_DOCUMENT_CANDIDATES &&
    !documentStore.dispatching;
  const canAsk = () => instruction().trim().length > 0 && hasPassage() && !saving() && !!askAgent();
  const installed = createMemo(() => agents().filter((a) => a.available !== false));
  const canSend = () =>
    instruction().trim().length > 0 && !!project() && installed().length > 0 && !sending();
  const askAgents = createMemo(() =>
    agents().filter((a) => a.available !== false && documentAgentSupport(a.id).headless),
  );
  const askAgent = () => askAgents().find((a) => a.id === askAgentId()) ?? askAgents()[0];

  /**
   * A question is saved beside the document, never into it, and answered by
   * the chosen agent.
   */
  async function askAgentAbout() {
    if (!canAsk()) return;
    setSaving(true);
    try {
      const saved = await addDocumentAnnotation('question', instruction().trim(), passageAnchor(), {
        askWith: askAgent(),
      });
      if (saved) {
        finish();
        focusAnnotation(saved.id);
      }
    } finally {
      setSaving(false);
    }
  }

  function passageAnchor() {
    const s = selection();
    return createAnchor(
      props.blocks,
      s.startBlock,
      s.endBlock,
      activeDocumentPath() ?? project()?.documentPath ?? '',
      documentStore.snapshot?.headSha ?? null,
    );
  }

  async function saveNote(close = false) {
    if (!hasPassage() || !instruction().trim()) return;
    const projectId = documentStore.projectId;
    const path = activeDocumentPath();
    const saved = await saveDocumentNoteDraft(passageAnchor());
    if (
      close &&
      saved &&
      documentStore.projectId === projectId &&
      documentStore.view === 'document' &&
      activeDocumentPath() === path &&
      !documentStore.composerDraft
    )
      props.onClose();
  }

  function close() {
    // After a failed save the draft is already backed up; Close must not retry
    // forever and trap the composer open.
    if (noteSaveFailed()) props.onClose();
    else if (mode() === 'note' && instruction().trim() && hasPassage()) void saveNote(true);
    else props.onClose();
  }

  function submit() {
    if (mode() === 'note') void saveNote(true);
    else if (mode() === 'question') void askAgentAbout();
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
      () =>
        [
          pickedRange(),
          documentStore.composerDraft?.id,
          documentStore.composerDraft?.mode,
          documentStore.composerDraft?.annotationId,
        ] as const,
      ([range]) => {
        const d = documentStore.composerDraft;
        if (!range && !d) {
          setFresh(false);
          return;
        }
        if (d) setInstruction(d.text);
        if (d?.mode) setMode(d.mode);
        setFresh(true);
        requestAnimationFrame(() => afterPress(() => textareaRef?.focus({ preventScroll: true })));
      },
    ),
  );

  // A comment is quick to reopen and saves on the way out, so a click anywhere
  // else puts it away, like a comment box in a word processor. The other modes
  // hold model choices and a longer draft, and stay up until closed.
  createEffect(() => {
    if (mode() !== 'note') return;
    const outside = (e: MouseEvent) => {
      if (e.target instanceof Node && rootRef?.contains(e.target)) return;
      // A press that keeps focus here (the toolbar's mode buttons) is not
      // leaving; nor is one on a scrollbar. Without a passage, the next click
      // is how the reader picks one for the waiting draft.
      if (e.defaultPrevented || onScrollbar(e) || !hasPassage()) return;
      // The click is usually on the next passage to comment on, so the comment
      // makes way at once and saves behind it. A failed save is reported, and
      // its backup returns with the next comment.
      if (!noteSaveFailed()) void saveNote();
      props.onClose();
    };
    document.addEventListener('mousedown', outside);
    onCleanup(() => document.removeEventListener('mousedown', outside));
  });

  // The field is disabled while saving, which drops its focus; after a failure
  // the reader types on, so it gets the focus back unless they went elsewhere.
  createEffect(
    on(noteSaveFailed, (failed) => {
      const active = document.activeElement;
      if (failed && (!active || active === document.body)) textareaRef?.focus();
    }),
  );

  function changeMode(next: ComposerMode) {
    setMode(next);
    setDocumentComposerDraft({ ...documentStore.composerDraft, text: instruction(), mode: next });
  }

  function handleFocusOut(e: FocusEvent) {
    if (!rootRef?.contains(e.relatedTarget as Node | null)) setFresh(false);
  }

  /** 1 is a single proposal; more drafts spread over the main agent first, then the others. */
  function setAlternatives(n: number) {
    if (n <= 1) return setCompare(false);
    const eligible = agents()
      .filter((a) => a.available !== false && documentAgentSupport(a.id).headless)
      .sort((a, b) => Number(b.id === mainAgentId()) - Number(a.id === mainAgentId()));
    if (eligible.length === 0) return;
    const next: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      const id = eligible[i % eligible.length].id;
      next[id] = (next[id] ?? 0) + 1;
    }
    setCounts(next);
    setCompare(true);
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
      setRailTab('runs');
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
      // The agent's reply lands in the panel, which may be collapsed.
      setRailTab('agent');
    } catch (err) {
      showNotification(errMessage(err));
    } finally {
      setSending(false);
    }
  }

  /** Work was handed off: close the composer and clear its passage. */
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
      close();
      return;
    }
    if (e.key === 'Enter') e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && (mode() !== 'note' || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      // The task terminal underneath treats Enter as its send shortcut.
      e.stopPropagation();
      submit();
    }
  }

  /** What the chosen mode does with the passage, said once beside the button. */
  const hint = () => {
    if (!isTask() && !hasPassage())
      return 'Select a passage in the document to attach this draft. Your text is kept.';
    if (!isTask()) return '';
    if (!oneshot()) return 'Edits the document directly.';
    return total() > MAX_DOCUMENT_CANDIDATES ? `Max ${MAX_DOCUMENT_CANDIDATES} candidates.` : '';
  };

  const scopeLabel = () => {
    const s = selection();
    if (s.wholeDocument) return isTask() ? 'Whole document' : 'Choose a passage';
    const lines =
      s.startLine === s.endLine ? `line ${s.startLine}` : `lines ${s.startLine}–${s.endLine}`;
    const label =
      s.startBlock === s.endBlock
        ? props.blocks[s.startBlock]?.type === 'paragraph'
          ? 'Selected paragraph'
          : 'Selected block'
        : 'Selected passage';
    return `${label} · ${s.heading ?? lines}`;
  };

  return (
    <div
      ref={rootRef}
      class="docws-composer"
      role="dialog"
      aria-label={
        mode() === 'note'
          ? 'Add comment'
          : mode() === 'question'
            ? 'Ask about this passage'
            : 'Rewrite'
      }
      classList={{
        'is-scoped': hasPassage(),
        'is-fresh': fresh(),
        'is-note': mode() === 'note',
        'has-note-status': mode() === 'note' && (noteSaving() || noteSaveFailed()),
      }}
      onFocusOut={handleFocusOut}
      onKeyDown={(e) => {
        // The field handles its own keys. Escape from the comment's buttons
        // closes it too; the other modes have pickers whose Escape is their own.
        if (e.key !== 'Escape' || mode() !== 'note' || e.target === textareaRef) return;
        e.preventDefault();
        e.stopPropagation();
        close();
      }}
    >
      {/* A comment has no title row: its close button and save status sit over
          the field's corner, so the box is little more than the field. */}
      <div class="docws-composer-head">
        <Show when={mode() !== 'note'}>
          <span class="docws-composer-title">{mode() === 'question' ? 'Ask' : 'Rewrite'}</span>
        </Show>
        <Show when={mode() !== 'note' && !hasPassage()}>
          <span class="docws-composer-scope" title={scopeLabel()}>
            {scopeLabel()}
          </span>
        </Show>
        <Show when={mode() === 'note'}>
          <span class="docws-note-status" role="status">
            {noteSaving() ? 'Saving…' : noteSaveFailed() ? 'Not saved' : ''}
          </span>
          {/* Kept in the layout so a failed save does not shift the header. */}
          <button
            type="button"
            class="docws-btn docws-btn-sm"
            style={{ visibility: noteSaveFailed() ? 'visible' : 'hidden' }}
            onClick={() => void saveNote()}
          >
            Retry
          </button>
        </Show>
        <button
          type="button"
          class="docws-composer-close"
          aria-label="Close"
          title="Close · Esc"
          onClick={close}
        >
          <CloseIcon size={14} />
        </button>
      </div>
      <Show when={hasPassage() && mode() !== 'note'}>
        <div class="docws-composer-quote" title={scopeLabel()}>
          {selection().quote.slice(0, 400)}
        </div>
      </Show>
      <textarea
        ref={textareaRef}
        aria-label={
          mode() === 'note' ? 'Comment' : mode() === 'question' ? 'Question' : 'Instruction'
        }
        onKeyDown={handleKeyDown}
        disabled={noteSaving()}
        onBlur={(e) => {
          // Leaving the window (alt-tab, devtools) is not leaving the note.
          if (!document.hasFocus()) return;
          if (mode() === 'note' && !rootRef?.contains(e.relatedTarget as Node | null))
            void saveNote();
        }}
        placeholder={
          isTask()
            ? hasPassage()
              ? 'What should change?'
              : 'What should change in this document?'
            : mode() === 'question'
              ? 'What would you like to know?'
              : 'Add a comment…'
        }
        value={instruction()}
        onInput={(e) => {
          setInstruction(e.currentTarget.value);
          setDocumentComposerDraft({
            ...documentStore.composerDraft,
            text: instruction(),
            mode: mode(),
          });
        }}
      />
      <Show when={oneshot()}>
        <details class="docws-proposal-options">
          <summary>
            Options · {total()} suggestion{total() === 1 ? '' : 's'}
          </summary>
          <Show when={oneshot()}>
            <Show when={!compare()}>
              <label class="docws-option-field">
                Agent
                <select
                  class="docws-select"
                  value={singleAgent()?.id ?? ''}
                  onChange={(e) => setSingleAgentId(e.currentTarget.value)}
                >
                  <For
                    each={agents().filter(
                      (a) => a.available !== false && documentAgentSupport(a.id).headless,
                    )}
                  >
                    {(agent) => <option value={agent.id}>{agent.name}</option>}
                  </For>
                </select>
              </label>
            </Show>
            <Show when={compare()}>
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
              </div>
            </Show>
            <details class="docws-proposal-options">
              <summary>Model and session</summary>
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
          </Show>
        </details>
      </Show>
      <Show when={!isTask() && (hint() || mode() === 'question')}>
        <div class="docws-composer-footer">
          <Show when={hint()}>
            <span class="docws-composer-hint">{hint()}</span>
          </Show>
          <Show when={mode() === 'question'}>
            <Show when={askAgents().length > 1}>
              <select
                class="docws-select"
                aria-label="Agent to ask"
                value={askAgent()?.id ?? ''}
                onChange={(e) => setAskAgentId(e.currentTarget.value)}
              >
                <For each={askAgents()}>
                  {(agent) => <option value={agent.id}>{agent.name}</option>}
                </For>
              </select>
            </Show>
            <button
              type="button"
              class="docws-btn docws-btn-sm docws-btn-primary"
              disabled={!canAsk()}
              title={
                askAgent()
                  ? `${askAgent()?.name} answers beside the passage`
                  : 'No agent is available.'
              }
              onClick={() => void askAgentAbout()}
            >
              {saving() ? 'Asking…' : 'Ask'}
            </button>
          </Show>
        </div>
      </Show>
      <Show when={isTask()}>
        <div class="docws-composer-footer">
          <Show when={hint()}>
            <span class="docws-composer-hint">{hint()}</span>
          </Show>
          <span class="docws-tabs" role="group" aria-label="After rewriting">
            <button
              type="button"
              class="docws-tab"
              aria-pressed={oneshot()}
              title="Draft proposals to review before anything changes"
              onClick={() => changeMode('proposals')}
            >
              Review first
            </button>
            <button
              type="button"
              class="docws-tab"
              aria-pressed={!oneshot()}
              title="Send the instruction to the agent, which edits the document"
              onClick={() => changeMode('task')}
            >
              Apply directly
            </button>
          </span>
          <Show when={oneshot()}>
            <span class="docws-tabs" role="group" aria-label="Alternatives">
              <For each={[1, 2, 3]}>
                {(n) => (
                  <button
                    type="button"
                    class="docws-tab"
                    aria-pressed={alternatives() === n}
                    title={n === 1 ? 'One proposal' : `Compare ${n} alternatives`}
                    onClick={() => setAlternatives(n)}
                  >
                    {n}
                  </button>
                )}
              </For>
            </span>
          </Show>
          <button
            type="button"
            class="docws-btn docws-btn-sm docws-btn-primary"
            disabled={oneshot() ? !canRun() : !canSend()}
            title={!oneshot() && installed().length === 0 ? 'No agent is installed.' : undefined}
            onClick={() => submit()}
          >
            <Show when={oneshot()} fallback={<SendIcon size={12} />}>
              <SparkleIcon size={12} />
            </Show>
            {documentStore.dispatching ? 'Starting…' : 'Rewrite'}
          </button>
        </div>
      </Show>
    </div>
  );
}
