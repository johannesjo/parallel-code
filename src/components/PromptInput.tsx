import { createSignal } from "solid-js";
import { sendPrompt } from "../store/store";
import { theme } from "../lib/theme";

interface PromptInputProps {
  taskId: string;
  agentId: string;
  onSend?: (text: string) => void;
}

export function PromptInput(props: PromptInputProps) {
  const [text, setText] = createSignal("");

  function handleSend() {
    const val = text().trim();
    if (!val) return;
    sendPrompt(props.taskId, props.agentId, val);
    props.onSend?.(val);
    setText("");
  }

  return (
    <div style={{ display: "flex", height: "100%", padding: "4px 6px" }}>
      <textarea
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
          "border-radius": "6px",
          padding: "6px 10px",
          color: theme.fg,
          "font-size": "12px",
          "font-family": "'JetBrains Mono', monospace",
          resize: "none",
          outline: "none",
        }}
      />
    </div>
  );
}
