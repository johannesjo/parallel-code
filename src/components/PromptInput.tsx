import { createSignal, createEffect, onMount, onCleanup, untrack } from 'solid-js';
import { fireAndForget } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import {
  store,
  sendPrompt,
  registerFocusFn,
  unregisterFocusFn,
  registerAction,
  unregisterAction,
  getAgentOutputTail,
  stripAnsi,
  onAgentReady,
  offAgentReady,
  normalizeCurrentFrame,
  looksLikeQuestion,
  isTrustQuestionAutoHandled,
  isAutoTrustSettling,
  isAgentAskingQuestion,
  getTaskFocusedPanel,
  setTaskFocusedPanel,
  setTaskLastInputAt,
} from '../store/store';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';

export interface PromptInputHandle {
  getText: () => string;
  setText: (value: string) => void;
}

interface PromptInputProps {
  taskId: string;
  agentId: string;
  initialPrompt?: string;
  prefillPrompt?: string;
  onPrefillConsumed?: () => void;
  onSend?: (text: string) => void;
  ref?: (el: HTMLTextAreaElement) => void;
  handle?: (h: PromptInputHandle) => void;
}

// Quiescence: how often to snapshot and how long output must be stable.
const QUIESCENCE_POLL_MS = 500;
const QUIESCENCE_THRESHOLD_MS = 1_500;
// Never auto-send before this (agent still booting).
const AUTOSEND_MIN_WAIT_MS = 500;
// After detecting the agent's prompt (❯/›), wait this long and re-verify
// it's still visible before sending.  Catches transient prompt renders
// during initialization (e.g. Claude Code renders ❯ before fully loading).
const PROMPT_RECHECK_DELAY_MS = 1_500;
// How many consecutive stability checks must pass before auto-sending.
// Each check verifies ❯ is present AND output hasn't changed since the
// previous check.  Multiple checks catch agents that render ❯ early and
// then silently load (no PTY output) — a single check can't distinguish
// "silently loading" from "truly idle at prompt".
const PROMPT_STABILITY_CHECKS = 2;
// How many consecutive stability-check failures (prompt visible but still changing)
// before we relax the isStable requirement and send anyway.
const STABILITY_MAX_FAILURES = 3;
// Give up after this.
const AUTOSEND_MAX_WAIT_MS = 45_000;
// After sending, how long to poll terminal output to confirm the prompt appeared.
const PROMPT_VERIFY_TIMEOUT_MS = 5_000;
const PROMPT_VERIFY_POLL_MS = 250;
const PROMPT_MARKER_SCAN_CHARS = 500;

/** True when auto-send should be blocked by a question in the output.
 *  Trust-dialog questions are NOT blocking when auto-trust handles them. */
const isQuestionBlockingAutoSend = (tail: string): boolean =>
  looksLikeQuestion(tail) && !isTrustQuestionAutoHandled(tail);

export function PromptInput(props: PromptInputProps) {
  const [text, setText] = createSignal('');
  const [sending, setSending] = createSignal(false);
  const [autoSentInitialPrompt, setAutoSentInitialPrompt] = createSignal<string | null>(null);
  let cleanupAutoSend: (() => void) | undefined;

  createEffect(() => {
    cleanupAutoSend?.();
    cleanupAutoSend = undefined;

    const ip = props.initialPrompt?.trim();
    if (!ip) return;

    setText(ip);
    if (autoSentInitialPrompt() === ip) return;

    const agentId = props.agentId;
    const spawnedAt = Date.now();
    let quiescenceTimer: number | undefined;
    let pendingSendTimer: ReturnType<typeof setTimeout> | undefined;
    let lastRawTail = '';
    let lastNormalized = '';
    // Start stableSince at 0, not Date.now().  Quiescence requires visible
    // content — agents that emit only escape sequences initially (e.g. Copilot
    // CLI entering alternate screen) must not trigger a send before anything
    // meaningful appears.  stableSince is set when the first non-empty
    // normalizeForComparison result is seen and stays updated from there.
    let stableSince = 0;
    let cancelled = false;
    // Counts consecutive stability-check failures where the prompt was visible
    // but the content was still changing (isStable=false).  After
    // STABILITY_MAX_FAILURES attempts we relax the requirement — the agent is
    // already showing its prompt so the content is good enough to send into.
    let stabilityCheckFailures = 0;

    function cleanup() {
      cancelled = true;
      offAgentReady(agentId);
      if (pendingSendTimer) {
        clearTimeout(pendingSendTimer);
        pendingSendTimer = undefined;
      }
      if (quiescenceTimer !== undefined) {
        clearInterval(quiescenceTimer);
        quiescenceTimer = undefined;
      }
    }
    cleanupAutoSend = cleanup;

    function isAgentDead() {
      return store.agents[agentId]?.status === 'exited';
    }

    function trySend() {
      if (cancelled) return;
      if (isAgentDead()) {
        cleanup();
        return;
      }
      // Don't tear down the auto-send mechanism if we can't send yet —
      // the quiescence timer needs to stay alive to retry after settling.
      if (isAutoTrustSettling(agentId)) return;
      cleanup();
      void handleSend('auto');
    }

    // --- FAST PATH: event from markAgentOutput ---
    // Fires when a known prompt pattern (❯, ›) is detected in PTY output.
    // The callback is one-shot (deleted after firing in markAgentOutput),
    // so we re-register when a question guard blocks to keep the fast path alive.
    function onReady() {
      if (cancelled) return;
      if (isQuestionBlockingAutoSend(getAgentOutputTail(agentId))) {
        onAgentReady(agentId, onReady);
        return;
      }
      // Don't start stability checks while auto-trust is actively handling a
      // trust/permission dialog — the ❯ in the TUI selection UI is not the
      // agent's main prompt yet.  Re-register; we'll be called again once the
      // agent fires tryFireAgentReadyCallback after the trust flow completes.
      if (isAutoTrustSettling(agentId)) {
        onAgentReady(agentId, onReady);
        return;
      }

      // Start a series of stability checks.  Some agents (e.g. Claude Code)
      // render ❯ before fully initializing — the marker persists while the
      // agent silently loads (no PTY output).  A single stability check
      // can't catch this, so we require PROMPT_STABILITY_CHECKS consecutive
      // checks to pass (output unchanged + ❯ still present in each).
      if (!pendingSendTimer) {
        startStabilityChecks();
      }
    }

    function startStabilityChecks() {
      stabilityCheckFailures = 0;
      let checksRemaining = PROMPT_STABILITY_CHECKS;
      const elapsed = Date.now() - spawnedAt;
      const recheckDelay =
        store.agents[agentId]?.def?.prompt_ready_delay_ms ?? PROMPT_RECHECK_DELAY_MS;
      const firstDelay = Math.max(recheckDelay, AUTOSEND_MIN_WAIT_MS - elapsed);

      function scheduleCheck(delay: number) {
        const snapshot = normalizeCurrentFrame(getAgentOutputTail(agentId));
        pendingSendTimer = setTimeout(() => {
          pendingSendTimer = undefined;
          if (cancelled) return;
          const tail = getAgentOutputTail(agentId);
          if (isQuestionBlockingAutoSend(tail)) {
            onAgentReady(agentId, onReady);
            return;
          }
          if (isAutoTrustSettling(agentId)) {
            onAgentReady(agentId, onReady);
            return;
          }
          const normalized = normalizeCurrentFrame(tail);
          const hasPrompt = /[❯›]/.test(stripAnsi(tail).slice(-PROMPT_MARKER_SCAN_CHARS));
          const isStable = normalized === snapshot;
          if (!hasPrompt || (!isStable && stabilityCheckFailures < STABILITY_MAX_FAILURES)) {
            if (hasPrompt && !isStable) stabilityCheckFailures++;
            onAgentReady(agentId, onReady);
            return;
          }
          // When isStable is false but we've exceeded failure limit, proceed anyway —
          // the prompt is visible and the agent is ready enough.
          checksRemaining--;
          if (checksRemaining <= 0) {
            trySend();
          } else {
            scheduleCheck(recheckDelay);
          }
        }, delay);
      }

      scheduleCheck(firstDelay);
    }

    onAgentReady(agentId, onReady);

    // --- SLOW PATH: quiescence fallback ---
    // Polls every 500ms.  When a prompt marker (❯/›) is visible, kicks off
    // the same stability checks as the fast path (needed when the agent is
    // idle and no new PTY data would trigger the fast-path callback).
    // For agents without recognizable prompt markers, falls through to pure
    // quiescence (1.5s of stable output).
    quiescenceTimer = window.setInterval(() => {
      if (cancelled) return;
      if (isAgentDead()) {
        cleanup();
        return;
      }
      const elapsed = Date.now() - spawnedAt;

      if (elapsed > AUTOSEND_MAX_WAIT_MS) {
        cleanup();
        return;
      }
      if (elapsed < AUTOSEND_MIN_WAIT_MS) return;
      // After auto-trust acceptance, wait for the agent to fully initialize.
      if (isAutoTrustSettling(agentId)) return;

      const tail = getAgentOutputTail(agentId);
      if (!tail) return;

      // If a prompt marker is visible, use the fast path's stability checks
      // instead of pure quiescence — they verify ❯ persists AND output is stable.
      // Kick off the checks directly rather than just re-registering a callback,
      // because the agent may be idle (no new PTY data to trigger the callback).
      // Guard: skip if the agent is known to be showing a question (e.g. a TUI
      // dialog with a ❯ selection cursor).  The stability check inside also guards,
      // but skipping here avoids scheduling unnecessary timers.
      if (/[❯›]/.test(stripAnsi(tail).slice(-PROMPT_MARKER_SCAN_CHARS))) {
        if (!pendingSendTimer && !questionActive()) startStabilityChecks();
        return;
      }

      // Skip expensive normalization if raw tail hasn't changed.
      if (tail === lastRawTail) {
        if (stableSince > 0 && Date.now() - stableSince >= QUIESCENCE_THRESHOLD_MS) {
          if (!isQuestionBlockingAutoSend(tail)) {
            trySend();
          } else {
            stableSince = Date.now();
          }
        }
        return;
      }
      lastRawTail = tail;

      const normalized = normalizeCurrentFrame(tail);

      // No visible content yet (e.g. only ANSI setup sequences) — don't start
      // the stability clock until something meaningful appears on screen.
      if (!normalized) return;

      if (normalized !== lastNormalized) {
        lastNormalized = normalized;
        stableSince = Date.now();
        return;
      }

      // First time we see non-empty normalized content, start the clock.
      if (stableSince === 0) {
        stableSince = Date.now();
        return;
      }

      if (Date.now() - stableSince < QUIESCENCE_THRESHOLD_MS) return;

      // Output stable long enough — check it's not a question.
      if (isQuestionBlockingAutoSend(tail)) {
        stableSince = Date.now();
        return;
      }

      trySend();
    }, QUIESCENCE_POLL_MS);
  });

  createEffect(() => {
    const pf = props.prefillPrompt?.trim();
    if (!pf) return;
    setText(pf);
    untrack(() => props.onPrefillConsumed?.());
  });

  // When the agent shows a question/dialog, focus the terminal so the user
  // can interact with the TUI directly.
  const questionActive = () => isAgentAskingQuestion(props.agentId);
  createEffect(() => {
    if (questionActive() && getTaskFocusedPanel(props.taskId) === 'prompt') {
      setTaskFocusedPanel(props.taskId, 'ai-terminal');
    }
  });

  let textareaRef: HTMLTextAreaElement | undefined;

  onMount(() => {
    props.handle?.({ getText: text, setText });
    const focusKey = `${props.taskId}:prompt`;
    const actionKey = `${props.taskId}:send-prompt`;
    registerFocusFn(focusKey, () => textareaRef?.focus());
    registerAction(actionKey, () => handleSend());
    onCleanup(() => {
      unregisterFocusFn(focusKey);
      unregisterAction(actionKey);
    });
  });

  onCleanup(() => {
    cleanupAutoSend?.();
    cleanupAutoSend = undefined;
    sendAbortController?.abort();
  });

  async function promptAppearedInOutput(
    agentId: string,
    prompt: string,
    preSendTail: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const snippet = stripAnsi(prompt).slice(0, 40);
    if (!snippet) return true;
    // If the snippet was already visible before send, skip verification
    // to avoid false positives.
    if (stripAnsi(preSendTail).includes(snippet)) return true;

    const deadline = Date.now() + PROMPT_VERIFY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (signal.aborted) return false;
      const tail = stripAnsi(getAgentOutputTail(agentId));
      if (tail.includes(snippet)) return true;
      await new Promise((r) => setTimeout(r, PROMPT_VERIFY_POLL_MS));
    }
    return false;
  }

  let sendAbortController: AbortController | undefined;

  async function handleSend(mode: 'manual' | 'auto' = 'manual') {
    if (sending()) return;
    // Block sends while the agent is showing a question/dialog.
    // For auto-sends, use a fresh tail-buffer check instead of the reactive
    // signal — the signal may be stale (updated by throttled analysis) while
    // the callers (onReady, quiescence timer) already verified with fresh data.
    if (mode === 'auto') {
      const tail = getAgentOutputTail(props.agentId);
      if (isQuestionBlockingAutoSend(tail)) {
        return;
      }
      if (isAutoTrustSettling(props.agentId)) {
        return;
      }
    } else {
      if (questionActive()) return;
      // Also block manual sends while auto-trust is actively handling a trust
      // dialog.  With autoTrustFolders enabled, questionActive is suppressed to
      // false for trust dialogs so the textarea stays enabled — but the user
      // must not accidentally send text into the dialog before auto-trust
      // accepts it (the \r from sendPrompt would confirm the TUI selection).
      if (isAutoTrustSettling(props.agentId)) return;
    }
    cleanupAutoSend?.();
    cleanupAutoSend = undefined;

    const val = text().trim();
    if (!val) {
      if (mode === 'auto') return;
      fireAndForget(IPC.WriteToAgent, { agentId: props.agentId, data: '\r' });
      setTaskLastInputAt(props.taskId);
      return;
    }

    sendAbortController?.abort();
    sendAbortController = new AbortController();
    const { signal } = sendAbortController;

    setSending(true);
    try {
      // Snapshot tail before send for verification comparison.
      const preSendTail = getAgentOutputTail(props.agentId);
      await sendPrompt(props.taskId, props.agentId, val);

      if (mode === 'auto') {
        // Wait for the prompt to appear in output before clearing the text field.
        await promptAppearedInOutput(props.agentId, val, preSendTail, signal);
      }

      if (signal.aborted) return;

      if (props.initialPrompt?.trim()) {
        setAutoSentInitialPrompt(props.initialPrompt.trim());
      }
      props.onSend?.(val);
      setText('');
    } catch (e) {
      console.error('Failed to send prompt:', e);
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      class="focusable-panel prompt-input-panel"
      style={{ display: 'flex', height: '100%', padding: '4px 6px', 'border-radius': '12px' }}
    >
      <div style={{ position: 'relative', flex: '1', display: 'flex' }}>
        <textarea
          class="prompt-textarea"
          ref={(el) => {
            textareaRef = el;
            props.ref?.(el);
          }}
          rows={3}
          value={text()}
          disabled={questionActive()}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={
            questionActive()
              ? 'Agent is waiting for input in terminal…'
              : 'Send a prompt... (Enter to send, Shift+Enter for newline)'
          }
          style={{
            flex: '1',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
            'border-radius': '12px',
            padding: '6px 36px 6px 10px',
            color: theme.fg,
            'font-size': sf(13),
            'font-family': "'JetBrains Mono', monospace",
            resize: 'none',
            outline: 'none',
            opacity: questionActive() ? '0.5' : '1',
          }}
        />
        <button
          class="prompt-send-btn"
          type="button"
          disabled={!text().trim() || questionActive()}
          onClick={() => handleSend()}
          style={{
            position: 'absolute',
            right: '6px',
            bottom: '6px',
            width: '24px',
            height: '24px',
            'border-radius': '50%',
            border: 'none',
            background: text().trim() ? theme.accent : theme.bgHover,
            color: text().trim() ? theme.accentText : theme.fgSubtle,
            cursor: text().trim() ? 'pointer' : 'default',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            padding: '0',
            transition: 'background 0.15s, color 0.15s',
          }}
          title="Send prompt"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M7 12V2M7 2L3 6M7 2l4 4"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
