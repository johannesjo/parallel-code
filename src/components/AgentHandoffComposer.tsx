import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  onMount,
  Show,
  untrack,
} from 'solid-js';
import type { SessionCaller } from '../../electron/shared/delegation-types';
import { cleanHandoffText, reviewerWithModel, secondOpinionText } from '../lib/agent-handoff';
import { dialogButtonStyle } from '../lib/theme';
import { errMessage } from '../lib/log';
import { store } from '../store/core';
import { delegationRequest, refreshDelegationState } from '../store/delegation';
import { addAgentToTask } from '../store/agents';
import { setAskCodeProvider } from '../store/ui';
import { isSupportedDelegationAgent, hasUserMcpConfiguration } from '../store/delegation';
import { Dialog } from './Dialog';
import { isAgentChat } from '../store/agent-chat';
import type { Task } from '../store/types';
import type { AgentDef } from '../ipc/types';
import { SendIcon } from './icons';
import { AgentModelMenu, chosenEffort } from './AgentModelMenu';
import { modelToRun } from '../lib/ask-code-model';
import { effortInArgs, modelInArgs } from '../lib/agent-args';
import { loadCodexModels } from '../lib/codex-models';
import { defaultAskCodeModel, type AskCodeProvider } from '../../electron/shared/ask-code-models';
import './AgentHandoffComposer.css';

// The delivery queue's limit (electron/mcp/delegation.ts MAX_PROMPT_BYTES).
const MAX_MESSAGE_BYTES = 64 * 1024;

/**
 * Ask another agent pane for a second opinion. The text box holds exactly what
 * is typed into the recipient's prompt and submitted; nothing is added to it.
 */
export function AgentHandoffComposer(props: {
  task: Task;
  sourceAgentId: string;
  selection?: string;
  recipientAgentId?: string;
  onClose: (recipientAgentId?: string) => void;
}) {
  const titleId = createUniqueId();
  const agentName = (id: string) => store.agents[id]?.def.name ?? 'Agent';
  // Cleaned up front, so what is shown is what is sent.
  const [text, setText] = createSignal(
    untrack(() =>
      cleanHandoffText(
        secondOpinionText({
          gitIsolation: props.task.gitIsolation,
          baseBranch: props.task.baseBranch,
          taskPrompt: props.task.savedInitialPrompt,
          selection: props.selection
            ? { agent: agentName(props.sourceAgentId), text: props.selection }
            : undefined,
        }),
      ),
    ),
  );
  const [sessions, setSessions] = createSignal<SessionCaller[]>([]);
  const [recipient, setRecipient] = createSignal('');
  const [starting, setStarting] = createSignal<{
    id: string;
    from: SessionCaller;
    prompt: string;
  }>();
  const [loading, setLoading] = createSignal(true);
  const [loaded, setLoaded] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal('');
  const reviewerDefs = () =>
    store.availableAgents.filter(
      (def) =>
        def.available !== false &&
        isSupportedDelegationAgent(def) &&
        !hasUserMcpConfiguration(def.args),
    );
  const newReviewer = () => reviewerDefs().find((def) => recipient() === `new:${def.id}`);
  const providerOf = (command: string): AskCodeProvider | undefined => {
    const name = command.split('/').pop();
    return name === 'claude' || name === 'codex' ? name : undefined;
  };
  // What the reviewer's own launch args set; shown and kept where the app chose nothing.
  const configured = (def: AgentDef) => ({
    model: modelInArgs(def.args),
    effort: effortInArgs(def.args),
  });
  // A fresh reviewer runs the model last chosen for this provider in the app.
  const modelFor = (def: AgentDef) => {
    const provider = providerOf(def.command);
    if (!provider) return '';
    return modelToRun(
      provider,
      (provider === store.askCodeProvider ? store.askCodeModel : defaultAskCodeModel(provider)) ||
        configured(def).model,
    );
  };
  const effortFor = (def: AgentDef) => {
    const provider = providerOf(def.command);
    return provider ? chosenEffort(provider, modelFor(def), configured(def).effort) : '';
  };
  let textRef: HTMLTextAreaElement | undefined;
  let disposed = false;
  let request: { key: string; id: string } | undefined;
  onCleanup(() => {
    disposed = true;
  });
  const available = (s: SessionCaller) => {
    const agent = store.agents[s.agentId];
    return (
      !!agent &&
      agent.status !== 'exited' &&
      !isAgentChat(props.task, s.agentId) &&
      agent.sessionInstanceId === s.sessionInstanceId &&
      props.task.agentIds.includes(s.agentId)
    );
  };
  const recipients = () =>
    sessions().filter((s) => s.agentId !== props.sourceAgentId && available(s));
  const source = () => sessions().find((s) => s.agentId === props.sourceAgentId && available(s));
  const target = () => recipients().find((s) => s.agentId === recipient());
  const choices = () => [
    ...recipients().map((s) => ({
      value: s.agentId,
      name: agentName(s.agentId),
      detail: `Open in pane ${props.task.agentIds.indexOf(s.agentId) + 1}`,
    })),
    ...reviewerDefs().map((def) => ({
      value: `new:${def.id}`,
      name: def.name,
      detail: 'New session',
    })),
  ];
  function choose(value: string) {
    setRecipient(value);
    const provider = providerOf(newReviewer()?.command ?? '');
    if (provider) setAskCodeProvider(provider);
  }
  // With nothing chosen yet, the first reviewer takes the Tab stop.
  const tabStop = () =>
    choices().some((choice) => choice.value === recipient()) ? recipient() : choices()[0]?.value;
  function moveChoice(e: KeyboardEvent, index: number) {
    const list = choices();
    const targets: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowDown: index + 1,
      ArrowLeft: index - 1,
      ArrowUp: index - 1,
      Home: 0,
      End: list.length - 1,
    };
    if (!(e.key in targets)) return;
    e.preventDefault();
    const next = (targets[e.key] + list.length) % list.length;
    choose(list[next].value);
    const group = (e.currentTarget as HTMLElement).parentElement;
    group?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  }
  const canSend = () =>
    !loading() && !sending() && !!source() && (!!target() || !!newReviewer()) && !!text().trim();

  /**
   * Load the open sessions. A reload keeps the chosen pane only while it still
   * runs `keep`; a restarted pane needs a new explicit choice.
   */
  async function loadSessions(keep?: { agentId: string; sessionInstanceId: string }) {
    try {
      const result = await delegationRequest<SessionCaller[]>({
        action: 'handoffSessions',
        taskId: props.task.id,
      });
      if (disposed) return;
      setSessions(result);
      setLoaded(true);
      setRecipient(
        untrack(() =>
          !keep
            ? initialRecipient()
            : result.some(
                  (s) =>
                    s.agentId === keep.agentId && s.sessionInstanceId === keep.sessionInstanceId,
                )
              ? keep.agentId
              : '',
        ),
      );
    } catch (err) {
      // After a failed send, that failure is the one worth explaining.
      if (!disposed) setError((shown) => shown || errMessage(err));
    } finally {
      if (!disposed) setLoading(false);
    }
  }
  function retryLoad() {
    setError('');
    setLoading(true);
    void loadSessions();
  }
  function initialRecipient(): string {
    if (props.recipientAgentId)
      // Never replace an explicitly chosen recipient that has gone away.
      return recipients().some((s) => s.agentId === props.recipientAgentId)
        ? props.recipientAgentId
        : '';
    const existing = recipients()[0];
    if (existing) return existing.agentId;
    const sourceDef = store.agents[props.sourceAgentId]?.def.id;
    const suggested =
      reviewerDefs().find((def) => providerOf(def.command) === store.askCodeProvider) ??
      reviewerDefs().find((def) => def.id !== sourceDef) ??
      reviewerDefs()[0];
    return suggested ? `new:${suggested.id}` : '';
  }
  onMount(() => {
    textRef?.focus();
    // The model button names the model, so Codex's display names are needed before it opens.
    loadCodexModels();
    void loadSessions();
  });

  async function queue(
    from: SessionCaller,
    to: { agentId: string; sessionInstanceId: string },
    prompt: string,
  ) {
    const key = JSON.stringify([
      from.agentId,
      from.sessionInstanceId,
      to.agentId,
      to.sessionInstanceId,
      prompt,
    ]);
    if (request?.key !== key) request = { key, id: crypto.randomUUID() };
    try {
      await delegationRequest({
        action: 'handoff',
        taskId: props.task.id,
        sourceAgentId: from.agentId,
        sourceSessionInstanceId: from.sessionInstanceId,
        agentId: to.agentId,
        sessionInstanceId: to.sessionInstanceId,
        prompt,
        requestId: request.id,
      });
      void refreshDelegationState(props.task.id).catch(() => undefined);
      if (!disposed) props.onClose(to.agentId);
    } catch (err) {
      if (disposed) return;
      setError(errMessage(err));
      // A reviewer started by this dialog only becomes choosable once listed here.
      await loadSessions(to);
    } finally {
      if (!disposed) setSending(false);
    }
  }
  // Spawning is user initiated. Wait for the exact launched session before queuing;
  // prompt readiness and trust questions are still handled by the existing delivery queue.
  createEffect(() => {
    const pending = starting();
    if (!pending) return;
    const agent = store.agents[pending.id];
    if (agent?.sessionInstanceId && agent.status !== 'exited') {
      setStarting(undefined);
      void queue(
        pending.from,
        { agentId: pending.id, sessionInstanceId: agent.sessionInstanceId },
        pending.prompt,
      );
      return;
    }
    const fail = () => {
      setStarting(undefined);
      setSending(false);
      setError('The reviewer did not start. Check its terminal; your text is kept.');
    };
    if (!agent || agent.status === 'exited') {
      fail();
      return;
    }
    const timer = setTimeout(fail, 30_000);
    onCleanup(() => clearTimeout(timer));
  });
  // A reviewer that came up after the wait gave up is still the chosen pane; list it
  // once it has a session, so a retry sends to it instead of spawning another. A send
  // in flight reloads on failure itself.
  createEffect(() => {
    const id = recipient();
    const agent = store.agents[id];
    if (sending() || !agent?.sessionInstanceId || agent.status === 'exited') return;
    if (untrack(sessions).some((s) => s.agentId === id)) return;
    void loadSessions({ agentId: id, sessionInstanceId: agent.sessionInstanceId });
  });
  // Clean while typing, so the box always shows exactly what will be sent.
  function cleanInput(el: HTMLTextAreaElement): string {
    const raw = el.value;
    const clean = cleanHandoffText(raw);
    if (clean !== raw) {
      // Only changes before the caret move it; a marker rewrite can lengthen text.
      const caret = Math.min(
        clean.length,
        cleanHandoffText(raw.slice(0, el.selectionStart)).length,
      );
      el.value = clean;
      el.setSelectionRange(caret, caret);
    }
    return clean;
  }
  async function startReviewer(def: AgentDef, from: SessionCaller, prompt: string) {
    try {
      const agentId = await addAgentToTask(
        props.task.id,
        reviewerWithModel(def, modelFor(def), effortFor(def)),
      );
      if (disposed) return;
      if (!agentId) throw new Error('Could not start reviewer');
      setRecipient(agentId); // Retain the new pane on failure; retry must not spawn another.
      setStarting({ id: agentId, from, prompt });
    } catch (err) {
      if (!disposed) {
        setError(errMessage(err));
        setSending(false);
      }
    }
  }
  async function send() {
    const from = source(),
      to = target(),
      def = newReviewer();
    if (!canSend() || !from) return;
    setSending(true);
    setError('');
    const prompt = text();
    const size = new TextEncoder().encode(prompt).length;
    if (size > MAX_MESSAGE_BYTES) {
      setError(
        `The message is too long (${Math.ceil(size / 1024)} KB). Shorten it to 64 KB or less.`,
      );
      setSending(false);
      return;
    }
    if (to) await queue(from, to, prompt);
    else if (def) await startReviewer(def, from, prompt);
  }

  const content = (
    <section
      class="agent-handoff"
      aria-labelledby={titleId}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !sending()) {
          e.stopPropagation();
          props.onClose();
        }
      }}
    >
      <header>
        <h2 id={titleId}>{props.selection ? 'Send selected text' : 'Second opinion'}</h2>
        <p class="handoff-hint">
          The message is pasted into the reviewer's prompt and sent as written.
        </p>
      </header>
      <div class="handoff-field">
        <div class="handoff-field-head">
          <span class="handoff-label">Reviewer</span>
          <div class="handoff-model">
            <Show
              when={newReviewer()}
              fallback={
                <span class="handoff-hint">{target() ? 'Keeps its current model' : ''}</span>
              }
            >
              {(def) => (
                <Show
                  when={providerOf(def().command)}
                  // Copilot keeps its model to itself; naming none beats a guess.
                >
                  {(provider) => (
                    <>
                      <span class="handoff-hint">Model</span>
                      <AgentModelMenu
                        label="Reviewer model"
                        showModel
                        showEffort
                        class="handoff-model-button"
                        disabled={sending()}
                        provider={provider()}
                        providers={[provider()]}
                        configured={configured(def())}
                      />
                    </>
                  )}
                </Show>
              )}
            </Show>
          </div>
        </div>
        <div class="handoff-choices" role="radiogroup" aria-label="Reviewer">
          {/* Chips appear once, in their final order, after the open sessions are known. */}
          <Show when={!loading()} fallback={<span class="handoff-hint">Loading sessions…</span>}>
            <For each={choices()}>
              {(choice, index) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={recipient() === choice.value}
                  // Roving focus: Tab reaches the chosen reviewer, arrows move the choice.
                  tabIndex={tabStop() === choice.value ? 0 : -1}
                  class={`agent-btn handoff-choice${recipient() === choice.value ? ' selected' : ''}`}
                  disabled={sending()}
                  onClick={() => choose(choice.value)}
                  onKeyDown={(e) => moveChoice(e, index())}
                >
                  <span>{choice.name}</span>
                  <span class="handoff-choice-detail">{choice.detail}</span>
                </button>
              )}
            </For>
          </Show>
        </div>
      </div>
      <label class="handoff-field">
        <span class="handoff-label">Message</span>
        <textarea
          ref={textRef}
          class="input-field"
          rows={props.selection ? 6 : 9}
          value={text()}
          disabled={sending()}
          onInput={(e) => setText(cleanInput(e.currentTarget))}
        />
      </label>
      <div class="handoff-actions">
        {/* Problems show beside the buttons, in space that is already there. */}
        <div class="handoff-status">
          <Show when={loaded() && !source()}>
            <p role="alert">
              {agentName(props.sourceAgentId)} needs collaboration tools. Restart it with tools
              enabled.
            </p>
          </Show>
          <Show when={error()}>
            <p role="alert">{error()}</p>
          </Show>
          <Show when={!loading() && !source()}>
            <button type="button" class="handoff-retry" onClick={retryLoad}>
              Try again
            </button>
          </Show>
        </div>
        <button
          class="btn-secondary"
          style={dialogButtonStyle(false, sending())}
          disabled={sending()}
          onClick={() => props.onClose()}
        >
          Cancel
        </button>
        <button
          class="btn-primary btn-with-icon"
          style={dialogButtonStyle(true, !canSend())}
          disabled={!canSend()}
          onClick={() => void send()}
        >
          <SendIcon size={12} /> {starting() ? 'Starting…' : sending() ? 'Sending…' : 'Send'}
        </button>
      </div>
    </section>
  );
  return (
    <Show when={!props.selection} fallback={content}>
      <Dialog
        open
        width="600px"
        panelStyle={{
          'max-width': 'calc(100vw - 32px)',
          'box-sizing': 'border-box',
          padding: '24px',
        }}
        labelledBy={titleId}
        onClose={() => {
          if (!sending()) props.onClose();
        }}
      >
        {content}
      </Dialog>
    </Show>
  );
}
