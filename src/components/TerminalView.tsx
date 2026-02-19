import { onMount, onCleanup, createEffect } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke, Channel } from "@tauri-apps/api/core";
import { getTerminalFontFamily } from "../lib/fonts";
import { getTerminalTheme } from "../lib/theme";
import { matchesGlobalShortcut } from "../lib/shortcuts";
import { isMac } from "../lib/platform";
import { store } from "../store/store";
import type { PtyOutput } from "../ipc/types";

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    arr[i] = bin.charCodeAt(i);
  }
  return arr;
}

interface TerminalViewProps {
  taskId: string;
  agentId: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  onExit?: (exitInfo: { exit_code: number | null; signal: string | null; last_output: string[] }) => void;
  onData?: (data: Uint8Array) => void;
  onPromptDetected?: (text: string) => void;
  onReady?: (focusFn: () => void) => void;
  fontSize?: number;
  autoFocus?: boolean;
  initialCommand?: string;
  isActive?: boolean;
}

export function TerminalView(props: TerminalViewProps) {
  let containerRef!: HTMLDivElement;
  let term: Terminal | undefined;
  let fitAddon: FitAddon | undefined;

  onMount(() => {
    // Capture props eagerly so cleanup/callbacks always use the original values
    const taskId = props.taskId;
    const agentId = props.agentId;
    const initialFontSize = props.fontSize ?? 13;

    term = new Terminal({
      cursorBlink: true,
      fontSize: initialFontSize,
      fontFamily: getTerminalFontFamily(store.terminalFont),
      theme: getTerminalTheme(store.themePreset),
      allowProposedApi: true,
      scrollback: 5000,
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(containerRef);
    props.onReady?.(() => term!.focus());

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== "keydown") return true;

      // Let global app shortcuts pass through to the window handler
      if (matchesGlobalShortcut(e)) return false;

      const isCopy = isMac
        ? e.metaKey && !e.shiftKey && e.key === "c"
        : e.ctrlKey && e.shiftKey && e.key === "C";
      const isPaste = isMac
        ? e.metaKey && !e.shiftKey && e.key === "v"
        : e.ctrlKey && e.shiftKey && e.key === "V";

      if (isCopy) {
        const sel = term!.getSelection();
        if (sel) navigator.clipboard.writeText(sel);
        return false;
      }

      if (isPaste) {
        navigator.clipboard.readText().then((text) => {
          if (text) enqueueInput(text);
        });
        return false;
      }

      return true;
    });

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
      });
      term.loadAddon(webgl);
    } catch {
      // WebGL2 not supported — DOM renderer used automatically
    }

    fitAddon.fit();

    if (props.autoFocus) {
      term.focus();
    }

    // Deduplicated fit+refresh: both ResizeObserver and IntersectionObserver
    // need to refit — a single RAF prevents redundant work in the same frame.
    let fitRAF: number | undefined;
    function requestFit() {
      if (fitRAF !== undefined) return;
      fitRAF = requestAnimationFrame(() => {
        fitRAF = undefined;
        fitAddon!.fit();
        term!.refresh(0, term!.rows - 1);
      });
    }

    let outputRaf: number | undefined;
    let outputQueue: Uint8Array[] = [];
    let outputQueuedBytes = 0;
    let outputWriteInFlight = false;
    let pendingExitPayload:
      | { exit_code: number | null; signal: string | null; last_output: string[] }
      | null = null;

    function emitExit(payload: { exit_code: number | null; signal: string | null; last_output: string[] }) {
      if (!term) return;
      term.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
      props.onExit?.(payload);
    }

    function flushOutputQueue() {
      if (!term || outputWriteInFlight || outputQueue.length === 0) return;

      const chunks = outputQueue;
      const totalBytes = outputQueuedBytes;
      outputQueue = [];
      outputQueuedBytes = 0;

      let payload: Uint8Array;
      if (chunks.length === 1) {
        payload = chunks[0];
      } else {
        payload = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
          payload.set(chunk, offset);
          offset += chunk.length;
        }
      }

      outputWriteInFlight = true;
      term.write(payload, () => {
        outputWriteInFlight = false;
        props.onData?.(payload);
        if (outputQueue.length > 0) {
          scheduleOutputFlush();
          return;
        }
        if (pendingExitPayload) {
          const exit = pendingExitPayload;
          pendingExitPayload = null;
          emitExit(exit);
        }
      });
    }

    function scheduleOutputFlush() {
      if (outputRaf !== undefined) return;
      outputRaf = requestAnimationFrame(() => {
        outputRaf = undefined;
        flushOutputQueue();
      });
    }

    function enqueueOutput(chunk: Uint8Array) {
      outputQueue.push(chunk);
      outputQueuedBytes += chunk.length;
      // Flush large bursts promptly to keep perceived latency low.
      if (outputQueuedBytes >= 64 * 1024) {
        flushOutputQueue();
      } else {
        scheduleOutputFlush();
      }
    }

    const onOutput = new Channel<PtyOutput>();
    let initialCommandSent = false;
    onOutput.onmessage = (msg) => {
      if (msg.type === "Data") {
        enqueueOutput(base64ToUint8Array(msg.data));
        if (!initialCommandSent && props.initialCommand) {
          initialCommandSent = true;
          setTimeout(() => enqueueInput(props.initialCommand! + "\r"), 50);
        }
      } else if (msg.type === "Exit") {
        pendingExitPayload = msg.data;
        flushOutputQueue();
        if (!outputWriteInFlight && outputQueue.length === 0 && pendingExitPayload) {
          const exit = pendingExitPayload;
          pendingExitPayload = null;
          emitExit(exit);
        }
      }
    };

    let inputBuffer = "";
    let pendingInput = "";
    let inputFlushTimer: number | undefined;

    function flushPendingInput() {
      if (!pendingInput) return;
      const data = pendingInput;
      pendingInput = "";
      if (inputFlushTimer !== undefined) {
        clearTimeout(inputFlushTimer);
        inputFlushTimer = undefined;
      }
      invoke("write_to_agent", { agentId, data });
    }

    function enqueueInput(data: string) {
      pendingInput += data;
      if (pendingInput.length >= 2048) {
        flushPendingInput();
        return;
      }
      if (inputFlushTimer !== undefined) return;
      inputFlushTimer = window.setTimeout(() => {
        inputFlushTimer = undefined;
        flushPendingInput();
      }, 8);
    }

    term.onData((data) => {
      if (props.onPromptDetected) {
        for (const ch of data) {
          if (ch === "\r") {
            const trimmed = inputBuffer.trim();
            if (trimmed) props.onPromptDetected!(trimmed);
            inputBuffer = "";
          } else if (ch === "\x7f") {
            inputBuffer = inputBuffer.slice(0, -1);
          } else if (ch === "\x03" || ch === "\x15") {
            inputBuffer = "";
          } else if (ch === "\x1b") {
            // Skip escape sequences — break out, rest of data may contain seq chars
            break;
          } else if (ch >= " ") {
            inputBuffer += ch;
          }
        }
      }
      enqueueInput(data);
    });

    let resizeFlushTimer: number | undefined;
    let pendingResize: { cols: number; rows: number } | null = null;
    let lastSentCols = -1;
    let lastSentRows = -1;

    function flushPendingResize() {
      if (!pendingResize) return;
      const { cols, rows } = pendingResize;
      pendingResize = null;
      if (cols === lastSentCols && rows === lastSentRows) return;
      lastSentCols = cols;
      lastSentRows = rows;
      invoke("resize_agent", { agentId, cols, rows });
    }

    term.onResize(({ cols, rows }) => {
      pendingResize = { cols, rows };
      if (resizeFlushTimer !== undefined) return;
      resizeFlushTimer = window.setTimeout(() => {
        resizeFlushTimer = undefined;
        flushPendingResize();
      }, 33);
    });

    const resizeObserver = new ResizeObserver(() => {
      requestFit();
    });
    resizeObserver.observe(containerRef);

    // Re-render when the terminal scrolls back into view (e.g. horizontal overflow)
    const intersectionObserver = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        requestFit();
      }
    });
    intersectionObserver.observe(containerRef);

    // Only disable cursor blink for non-focused terminals to save one RAF
    // loop per terminal. All other resources (WebGL, observers) stay active
    // because all task panels are visible simultaneously in the tiling layout.
    createEffect(() => {
      if (!term) return;
      term.options.cursorBlink = props.isActive !== false;
    });

    invoke("spawn_agent", {
      taskId,
      agentId,
      command: props.command,
      args: props.args,
      cwd: props.cwd,
      env: props.env ?? {},
      cols: term.cols,
      rows: term.rows,
      onOutput,
    }).catch((err) => {
      term!.write(`\x1b[31mFailed to spawn: ${err}\x1b[0m\r\n`);
      props.onExit?.({
        exit_code: null,
        signal: "spawn_failed",
        last_output: [`Failed to spawn: ${String(err)}`],
      });
    });

    onCleanup(() => {
      flushPendingInput();
      flushPendingResize();
      if (inputFlushTimer !== undefined) clearTimeout(inputFlushTimer);
      if (resizeFlushTimer !== undefined) clearTimeout(resizeFlushTimer);
      if (outputRaf !== undefined) cancelAnimationFrame(outputRaf);
      if (fitRAF !== undefined) cancelAnimationFrame(fitRAF);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      invoke("kill_agent", { agentId });
      term!.dispose();
    });
  });

  createEffect(() => {
    const size = props.fontSize;
    if (size == null || !term || !fitAddon) return;
    term.options.fontSize = size;
    fitAddon.fit();
    term.refresh(0, term.rows - 1);
  });

  createEffect(() => {
    const font = store.terminalFont;
    if (!term || !fitAddon) return;
    term.options.fontFamily = getTerminalFontFamily(font);
    fitAddon.fit();
    term.refresh(0, term.rows - 1);
  });

  createEffect(() => {
    const preset = store.themePreset;
    if (!term) return;
    term.options.theme = getTerminalTheme(preset);
    term.refresh(0, term.rows - 1);
  });

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%", overflow: "hidden", padding: "4px 0 0 4px" }}
    />
  );
}
