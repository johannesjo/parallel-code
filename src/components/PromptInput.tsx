import { createSignal, createEffect, onMount, onCleanup } from "solid-js";
import { invoke } from "../lib/ipc";
import { IPC } from "../../electron/ipc/channels";
import {
  sendPrompt,
  registerFocusFn,
  unregisterFocusFn,
  registerAction,
  unregisterAction,
  getAgentOutputTail,
  stripAnsi,
  onAgentReady,
  offAgentReady,
  normalizeForComparison,
  looksLikeQuestion,
  isAgentAskingQuestion,
  getTaskFocusedPanel,
  setTaskFocusedPanel,
} from "../store/store";
import { theme } from "../lib/theme";
import { sf } from "../lib/fontScale";

export interface PromptInputHandle {
  getText: () => string;
  setText: (value: string) => void;
}

interface PromptInputProps {
  taskId: string;
  agentId: string;
  initialPrompt?: string;
  onSend?: (text: string) => void;
  ref?: (el: HTMLTextAreaElement) => void;
  handle?: (h: PromptInputHandle) => void;
}

// Quiescence: how often to snapshot and how long output must be stable.
const QUIESCENCE_POLL_MS = 500;
const QUIESCENCE_THRESHOLD_MS = 1_500;
// Never auto-send before this (agent still booting).
const AUTOSEND_MIN_WAIT_MS = 500;
// Give up after this.
const AUTOSEND_MAX_WAIT_MS = 45_000;
// After sending, how long to poll terminal output to confirm the prompt appeared.
const PROMPT_VERIFY_TIMEOUT_MS = 5_000;
const PROMPT_VERIFY_POLL_MS = 250;

export function PromptInput(props: PromptInputProps) {
  const [text, setText] = createSignal("");
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
    let lastRawTail = "";
    let lastNormalized = "";
    let stableSince = 0;
    let cancelled = false;

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

    function trySend() {
      if (cancelled) return;
      cleanup();
      void handleSend("auto");
    }

    // --- FAST PATH: event from markAgentOutput ---
    // Fires when a known prompt pattern (❯, ›) is detected in PTY output.
    // The callback is one-shot (deleted after firing in markAgentOutput),
    // so we re-register when a question guard blocks to keep the fast path alive.
    function onReady() {
      if (cancelled) return;
      const elapsed = Date.now() - spawnedAt;
      if (looksLikeQuestion(getAgentOutputTail(agentId))) {
        // Question still visible — re-register for the next prompt chunk.
        onAgentReady(agentId, onReady);
        return;
      }

      if (elapsed < AUTOSEND_MIN_WAIT_MS) {
        // Prompt detected early — schedule send for when min wait expires.
        if (!pendingSendTimer) {
          pendingSendTimer = setTimeout(() => {
            if (cancelled) return;
            if (looksLikeQuestion(getAgentOutputTail(agentId))) return;
            trySend();
          }, AUTOSEND_MIN_WAIT_MS - elapsed);
        }
        return;
      }

      trySend();
    }
    onAgentReady(agentId, onReady);

    // --- SLOW PATH: quiescence fallback for agents without whitelisted prompts ---
    quiescenceTimer = window.setInterval(() => {
      if (cancelled) return;
      const elapsed = Date.now() - spawnedAt;

      if (elapsed > AUTOSEND_MAX_WAIT_MS) {
        cleanup();
        return;
      }
      if (elapsed < AUTOSEND_MIN_WAIT_MS) return;

      const tail = getAgentOutputTail(agentId);
      if (!tail) return;

      // Skip expensive normalization if raw tail hasn't changed.
      if (tail === lastRawTail) {
        if (stableSince > 0 && Date.now() - stableSince >= QUIESCENCE_THRESHOLD_MS) {
          if (!looksLikeQuestion(tail)) { trySend(); }
          else { stableSince = Date.now(); }
        }
        return;
      }
      lastRawTail = tail;

      const normalized = normalizeForComparison(tail);

      if (normalized !== lastNormalized) {
        lastNormalized = normalized;
        stableSince = Date.now();
        return;
      }

      if (Date.now() - stableSince < QUIESCENCE_THRESHOLD_MS) return;

      // Output stable long enough — check it's not a question.
      if (looksLikeQuestion(tail)) {
        stableSince = Date.now();
        return;
      }

      trySend();
    }, QUIESCENCE_POLL_MS);
  });

  // When the agent shows a question/dialog, focus the terminal so the user
  // can interact with the TUI directly.
  const questionActive = () => isAgentAskingQuestion(props.agentId);
  createEffect(() => {
    if (questionActive() && getTaskFocusedPanel(props.taskId) === "prompt") {
      setTaskFocusedPanel(props.taskId, "ai-terminal");
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

  async function promptAppearedInOutput(agentId: string, prompt: string, preSendTail: string, signal: AbortSignal): Promise<boolean> {
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

  async function handleSend(mode: "manual" | "auto" = "manual") {
    if (sending()) return;
    // Block sends while the agent is showing a question/dialog.
    // For auto-sends, use a fresh tail-buffer check instead of the reactive
    // signal — the signal may be stale (updated by throttled analysis) while
    // the callers (onReady, quiescence timer) already verified with fresh data.
    if (mode === "auto") {
      if (looksLikeQuestion(getAgentOutputTail(props.agentId))) return;
    } else {
      if (questionActive()) return;
    }
    cleanupAutoSend?.();
    cleanupAutoSend = undefined;

    const val = text().trim();
    if (!val) {
      if (mode === "auto") return;
      await invoke(IPC.WriteToAgent, { agentId: props.agentId, data: "\r" });
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

      if (mode === "auto") {
        const confirmed = await promptAppearedInOutput(props.agentId, val, preSendTail, signal);
        if (!confirmed) return;
      }

      if (props.initialPrompt?.trim()) {
        setAutoSentInitialPrompt(props.initialPrompt.trim());
      }
      props.onSend?.(val);
      setText("");
    } catch (e) {
      console.error("Failed to send prompt:", e);
    } finally {
      setSending(false);
    }
  }

  return (
    <div class="focusable-panel prompt-input-panel" style={{ display: "flex", height: "100%", padding: "4px 6px", "border-radius": "12px" }}>
      <div style={{ position: "relative", flex: "1", display: "flex" }}>
        <textarea
          class="prompt-textarea"
          ref={(el) => { textareaRef = el; props.ref?.(el); }}
          rows={3}
          value={text()}
          disabled={questionActive()}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={questionActive() ? "Agent is waiting for input in terminal…" : "Send a prompt... (Enter to send, Shift+Enter for newline)"}
          style={{
            flex: "1",
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
            "border-radius": "12px",
            padding: "6px 36px 6px 10px",
            color: theme.fg,
            "font-size": sf(12),
            "font-family": "'JetBrains Mono', monospace",
            resize: "none",
            outline: "none",
            opacity: questionActive() ? "0.5" : "1",
          }}
        />
        <button
          class="prompt-send-btn"
          type="button"
          disabled={!text().trim() || questionActive()}
          onClick={() => handleSend()}
          style={{
            position: "absolute",
            right: "6px",
            bottom: "6px",
            width: "24px",
            height: "24px",
            "border-radius": "50%",
            border: "none",
            background: text().trim() ? theme.accent : theme.bgHover,
            color: text().trim() ? theme.accentText : theme.fgSubtle,
            cursor: text().trim() ? "pointer" : "default",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            padding: "0",
            transition: "background 0.15s, color 0.15s",
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
