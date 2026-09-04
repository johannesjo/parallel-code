import { For, Show, createMemo, createSignal } from 'solid-js';
import { createHighlightedMarkdown } from '../lib/marked-shiki';
import { store } from '../store/core';
import { getProject } from '../store/projects';
import {
  askDocumentAnnotation,
  deleteDocumentAnnotation,
  documentMainAgentId,
  documentStore,
  setDocumentAnnotationResolved,
  updateDocumentAnnotationText,
} from './store';
import { documentAgentSupport } from '../../electron/documents/shared';
import type { DocumentAnnotation } from './types';

interface AnnotationBubbleProps {
  annotation: DocumentAnnotation;
  /** The passage could not be found in the current version. */
  detached?: boolean;
  onMakeTask: (annotation: DocumentAnnotation) => void;
}

/**
 * A note or a question beside the document. Resolved bubbles collapse to one
 * line; Delete or Backspace on a focused bubble removes it, with undo in the
 * toolbar instead of a confirmation.
 */
export function AnnotationBubble(props: AnnotationBubbleProps) {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  const answerHtml = createHighlightedMarkdown(() => props.annotation.answer?.text);
  const project = () => (documentStore.projectId ? getProject(documentStore.projectId) : undefined);
  const askAgents = createMemo(() =>
    store.availableAgents.filter(
      (a) => a.available !== false && documentAgentSupport(a.id).headless,
    ),
  );
  const defaultAgent = () =>
    askAgents().find((a) => a.id === documentMainAgentId(project())) ?? askAgents()[0];
  const isQuestion = () => props.annotation.kind === 'question';
  const status = () => props.annotation.answerStatus;

  function handleKeyDown(e: KeyboardEvent) {
    if (editing()) return;
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      void deleteDocumentAnnotation(props.annotation.id);
    } else if (e.key === 'r' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      void setDocumentAnnotationResolved(props.annotation.id, !props.annotation.resolved);
    }
  }

  function startEdit() {
    setDraft(props.annotation.text);
    setEditing(true);
  }

  function commitEdit() {
    setEditing(false);
    void updateDocumentAnnotationText(props.annotation.id, draft().trim() || props.annotation.text);
  }

  const kindLabel = () => (isQuestion() ? 'Question' : 'Note');

  return (
    <div
      class="docws-bubble"
      classList={{
        'is-resolved': props.annotation.resolved,
        'is-detached': props.detached === true,
        'is-question': isQuestion(),
      }}
      tabIndex={0}
      role="group"
      aria-label={`${kindLabel()}: ${props.annotation.text.slice(0, 80)}`}
      onKeyDown={handleKeyDown}
    >
      <Show
        when={!props.annotation.resolved}
        fallback={
          <button
            type="button"
            class="docws-bubble-collapsed"
            title="Resolved. Click to reopen."
            onClick={() => void setDocumentAnnotationResolved(props.annotation.id, false)}
          >
            <span class="docws-badge">{props.annotation.runId ? 'task' : 'resolved'}</span>
            <span class="docws-bubble-collapsed-text">{props.annotation.text}</span>
          </button>
        }
      >
        <div class="docws-bubble-head">
          <span class="docws-badge">{kindLabel()}</span>
          <Show when={props.detached}>
            <span
              class="docws-badge docws-badge-stale"
              title="The passage this was attached to is no longer in the document"
            >
              detached
            </span>
          </Show>
          <span class="docws-bubble-time">
            {new Date(props.annotation.createdAt).toLocaleString()}
          </span>
          <span class="docws-spacer" />
          <button
            type="button"
            class="docws-btn docws-btn-sm"
            title="Resolve (r)"
            onClick={() => void setDocumentAnnotationResolved(props.annotation.id, true)}
          >
            Resolve
          </button>
          <button
            type="button"
            class="docws-btn docws-btn-sm"
            title="Send this to an agent as a task on the passage"
            onClick={() => props.onMakeTask(props.annotation)}
          >
            Make task
          </button>
          <button
            type="button"
            class="docws-btn docws-btn-sm docws-btn-danger"
            title="Delete (Del). Undo from the toolbar."
            onClick={() => void deleteDocumentAnnotation(props.annotation.id)}
          >
            ×
          </button>
        </div>
        <Show when={props.detached}>
          <div class="docws-bubble-quote" title="Passage as it was when the note was written">
            {props.annotation.anchor.quote.slice(0, 300)}
          </div>
        </Show>
        <Show
          when={!editing()}
          fallback={
            <textarea
              class="docws-note"
              value={draft()}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setEditing(false);
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  commitEdit();
                }
              }}
              ref={(el) => requestAnimationFrame(() => el.focus())}
            />
          }
        >
          <div class="docws-bubble-text" onDblClick={startEdit} title="Double-click to edit">
            {props.annotation.text}
          </div>
        </Show>
        <Show when={isQuestion()}>
          <div class="docws-bubble-answer">
            <Show when={status() === 'pending'}>
              <div class="docws-bubble-pending">
                <span class="docws-dot docws-dot-running" /> Answering…
              </div>
            </Show>
            <Show when={status() === 'failed'}>
              <div class="docws-error">
                {props.annotation.answerError ?? 'The agent gave no answer.'}
              </div>
            </Show>
            <Show when={props.annotation.answer}>
              {(answer) => (
                <>
                  <div class="docws-bubble-answer-head">
                    <span class="docws-badge">answer</span>
                    <span>{answer().agentName}</span>
                    <Show when={status() === 'answered' && props.annotation.answerError}>
                      <span class="docws-warning">{props.annotation.answerError}</span>
                    </Show>
                  </div>
                  {/* eslint-disable-next-line solid/no-innerhtml -- DOMPurify-sanitized markdown from the agent's answer */}
                  <div class="plan-markdown docws-bubble-answer-body" innerHTML={answerHtml()} />
                </>
              )}
            </Show>
            <Show when={status() !== 'pending' && askAgents().length > 0}>
              <div class="docws-run-actions">
                <For each={askAgents()}>
                  {(agent) => (
                    <button
                      type="button"
                      class="docws-btn docws-btn-sm"
                      title={`${props.annotation.answer ? 'Ask again' : 'Ask'} ${agent.name}`}
                      onClick={() => void askDocumentAnnotation(props.annotation.id, agent)}
                    >
                      {props.annotation.answer ? 'Ask again' : 'Ask'}
                      {askAgents().length > 1 || agent.id !== defaultAgent()?.id
                        ? ` · ${agent.name}`
                        : ''}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </Show>
    </div>
  );
}
