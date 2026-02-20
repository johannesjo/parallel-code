import { onMount, onCleanup, createEffect } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke, Channel } from "../lib/ipc";
import { getTerminalFontFamily } from "../lib/fonts";
import { getTerminalTheme } from "../lib/theme";
import { matchesGlobalShortcut } from "../lib/shortcuts";
import { isMac } from "../lib/platform";
import { store } from "../store/store";
import { registerTerminal, unregisterTerminal, markDirty } from "../lib/terminalFitManager";
import type { PtyOutput } from "../ipc/types";

// Pre-computed base64 lookup table — avoids atob() intermediate string allocation.
const B64_LOOKUP = new Uint8Array(128);
for (let i = 0; i < 64; i++) {
  B64_LOOKUP["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".charCodeAt(i)] = i;
}

function base64ToUint8Array(b64: string): Uint8Array {
  let end = b64.length;
  while (end > 0 && b64.charCodeAt(end - 1) === 61 /* '=' */) end--;
  const out = new Uint8Array((end * 3) >>> 2);
  let j = 0;
  for (let i = 0; i < end; ) {
    const a = B64_LOOKUP[b64.charCodeAt(i++)];
    const b = i < end ? B64_LOOKUP[b64.charCodeAt(i++)] : 0;
    const c = i < end ? B64_LOOKUP[b64.charCodeAt(i++)] : 0;
    const d = i < end ? B64_LOOKUP[b64.charCodeAt(i++)] : 0;
    const triplet = (a << 18) | (b << 12) | (c << 6) | d;
    out[j++] = (triplet >>> 16) & 0xff;
    if (j < out.length) out[j++] = (triplet >>> 8) & 0xff;
    if (j < out.length) out[j++] = triplet & 0xff;
  }
  return out;
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
  isFocused?: boolean;
}

// Status parsing only needs recent output. Capping forwarded bytes avoids
// expensive full-chunk decoding during large terminal bursts.
const STATUS_ANALYSIS_MAX_BYTES = 8 * 1024;

export function TerminalView(props: TerminalViewProps) {
  let containerRef!: HTMLDivElement;
  let term: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  let webglAddon: WebglAddon | undefined;

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
      scrollback: 3000,
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

    fitAddon.fit();
    registerTerminal(agentId, containerRef, fitAddon, term);

    if (props.autoFocus) {
      term.focus();
    }

    let outputRaf: number | undefined;
    let outputQueue: Uint8Array[] = [];
    let outputQueuedBytes = 0;
    let outputWriteInFlight = false;
    let watermark = 0;
    let ptyPaused = false;
    const FLOW_HIGH = 256 * 1024; // 256KB — pause PTY reader
    const FLOW_LOW = 32 * 1024;   // 32KB — resume PTY reader
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

      const statusPayload =
        payload.length > STATUS_ANALYSIS_MAX_BYTES
          ? payload.subarray(payload.length - STATUS_ANALYSIS_MAX_BYTES)
          : payload;

      outputWriteInFlight = true;
      term.write(payload, () => {
        outputWriteInFlight = false;
        watermark = Math.max(watermark - payload.length, 0);

        // Resume PTY reader when xterm.js has caught up
        if (watermark < FLOW_LOW && ptyPaused) {
          ptyPaused = false;
          invoke("resume_agent", { agentId }).catch(() => { ptyPaused = false; });
        }

        props.onData?.(statusPayload);
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
      watermark += chunk.length;

      // Pause PTY reader when xterm.js falls behind
      if (watermark > FLOW_HIGH && !ptyPaused) {
        ptyPaused = true;
        invoke("pause_agent", { agentId }).catch(() => { ptyPaused = false; });
      }

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

    // Only disable cursor blink for non-focused terminals to save one RAF
    // loop per terminal.
    createEffect(() => {
      if (!term) return;
      term.options.cursorBlink = props.isFocused === true;
    });

    // Load WebGL addon for all terminals. On context loss (e.g. too many
    // WebGL contexts), the terminal gracefully falls back to the DOM renderer.
    try {
      webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon?.dispose();
        webglAddon = undefined;
      });
      term.loadAddon(webglAddon);
    } catch {
      // WebGL2 not supported — DOM renderer used automatically
    }

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
      webglAddon?.dispose();
      webglAddon = undefined;
      unregisterTerminal(agentId);
      // kill_agent already clears paused flag before killing
      invoke("kill_agent", { agentId });
      term!.dispose();
    });
  });

  createEffect(() => {
    const size = props.fontSize;
    if (size == null || !term || !fitAddon) return;
    term.options.fontSize = size;
    markDirty(props.agentId);
  });

  createEffect(() => {
    const font = store.terminalFont;
    if (!term || !fitAddon) return;
    term.options.fontFamily = getTerminalFontFamily(font);
    markDirty(props.agentId);
  });

  createEffect(() => {
    const preset = store.themePreset;
    if (!term) return;
    term.options.theme = getTerminalTheme(preset);
    markDirty(props.agentId);
  });

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%", overflow: "hidden", padding: "4px 0 0 4px", contain: "strict" }}
    />
  );
}
