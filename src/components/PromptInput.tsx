import { createSignal, createEffect, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
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
} from "../store/store";
import { theme } from "../lib/theme";
import { sf } from "../lib/fontScale";

interface PromptInputProps {
  taskId: string;
  agentId: string;
  initialPrompt?: string;
  onSend?: (text: string) => void;
  ref?: (el: HTMLTextAreaElement) => void;
}

// Quiescence: how often to snapshot and how long output must be stable.
const QUIESCENCE_POLL_MS = 500;
const QUIESCENCE_THRESHOLD_MS = 2_500;
// Never auto-send before this (agent still booting).
const AUTOSEND_MIN_WAIT_MS = 1_000;
// Give up after this.
const AUTOSEND_MAX_WAIT_MS = 45_000;
// After sending, how long to poll terminal output to confirm the prompt appeared.
const PROMPT_VERIFY_TIMEOUT_MS = 5_000;
const PROMPT_VERIFY_POLL_MS = 250;

export function PromptInput(props: PromptInputProps) {
  const [text, setText] = createSignal("");
  const [sending, setSending] = createSignal(false);
  let autoSentInitialPrompt: string | null = null;
  let cleanupAutoSend: (() => void) | undefined;

  createEffect(() => {
    cleanupAutoSend?.();
    cleanupAutoSend = undefined;

    const ip = props.initialPrompt?.trim();
    if (!ip) return;

    setText(ip);
    if (autoSentInitialPrompt === ip) return;

    const agentId = props.agentId;
    const spawnedAt = Date.now();
    let quiescenceTimer: number | undefined;
    let pendingSendTimer: ReturnType<typeof setTimeout> | undefined;
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
    onAgentReady(agentId, () => {
      if (cancelled) return;
      const elapsed = Date.now() - spawnedAt;
      if (looksLikeQuestion(getAgentOutputTail(agentId))) return;

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
    });

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

  let textareaRef: HTMLTextAreaElement | undefined;

  onMount(() => {
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
  });

  async function promptAppearedInOutput(agentId: string, prompt: string, preSendTail: string): Promise<boolean> {
    const snippet = stripAnsi(prompt).slice(0, 40);
    if (!snippet) return true;
    // If the snippet was already visible before send, skip verification
    // to avoid false positives.
    if (stripAnsi(preSendTail).includes(snippet)) return true;

    const deadline = Date.now() + PROMPT_VERIFY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const tail = stripAnsi(getAgentOutputTail(agentId));
      if (tail.includes(snippet)) return true;
      await new Promise((r) => setTimeout(r, PROMPT_VERIFY_POLL_MS));
    }
    return false;
  }

  async function handleSend(mode: "manual" | "auto" = "manual") {
    if (sending()) return;
    cleanupAutoSend?.();
    cleanupAutoSend = undefined;

    const val = text().trim();
    if (!val) {
      if (mode === "auto") return;
      await invoke("write_to_agent", { agentId: props.agentId, data: "\r" });
      return;
    }

    setSending(true);
    try {
      // Snapshot tail before send for verification comparison.
      const preSendTail = getAgentOutputTail(props.agentId);
      await sendPrompt(props.taskId, props.agentId, val);

      if (mode === "auto") {
        const confirmed = await promptAppearedInOutput(props.agentId, val, preSendTail);
        if (!confirmed) return;
      }

      if (props.initialPrompt?.trim()) {
        autoSentInitialPrompt = props.initialPrompt.trim();
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
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Send a prompt... (Enter to send, Shift+Enter for newline)"
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
          }}
        />
        <button
          class="prompt-send-btn"
          type="button"
          disabled={!text().trim()}
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
