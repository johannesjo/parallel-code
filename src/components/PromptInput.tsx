import { createSignal, createEffect, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { sendPrompt, registerFocusFn, unregisterFocusFn, registerAction, unregisterAction } from "../store/store";
import { theme } from "../lib/theme";
import { sf } from "../lib/fontScale";

interface PromptInputProps {
  taskId: string;
  agentId: string;
  initialPrompt?: string;
  onSend?: (text: string) => void;
  ref?: (el: HTMLTextAreaElement) => void;
}

export function PromptInput(props: PromptInputProps) {
  const [text, setText] = createSignal("");

  createEffect(() => {
    const ip = props.initialPrompt;
    if (ip) {
      setText(ip);
    }
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

  async function handleSend() {
    const val = text().trim();
    if (!val) {
      await invoke("write_to_agent", { agentId: props.agentId, data: "\r" });
      return;
    }
    try {
      await sendPrompt(props.taskId, props.agentId, val);
      props.onSend?.(val);
      setText("");
    } catch (e) {
      console.error("Failed to send prompt:", e);
    }
  }

  return (
    <div class="focusable-panel" style={{ display: "flex", height: "100%", padding: "4px 6px", "border-radius": "12px" }}>
      <div style={{ position: "relative", flex: "1", display: "flex" }}>
        <textarea
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
          type="button"
          disabled={!text().trim()}
          onClick={handleSend}
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
