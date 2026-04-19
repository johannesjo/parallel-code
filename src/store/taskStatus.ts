import { createSignal } from 'solid-js';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { store, setStore } from './core';
import type { WorktreeStatus } from '../ipc/types';

// --- Trust-specific patterns (subset of QUESTION_PATTERNS) ---
// These are auto-accepted when autoTrustFolders is enabled.
// Note: TUI apps (Ink/blessed) use ANSI cursor-positioning to lay out text.
// After stripping ANSI, words run together (e.g. "Itrustthisfolder"),
// so patterns must work without word boundaries or spaces.
const TRUST_PATTERNS: RegExp[] = [
  /\btrust\b.*\?/i, // normal text with spaces: "trust this folder?"
  /\ballow\b.*\?/i, // normal text: "allow access?"
  /trust.*folder/i, // TUI-garbled: "Itrustthisfolder"
  /confirm.*folder.*trust/i, // Copilot CLI: "Confirm folder trust" (normal and garbled)
];

// Safety guard: reject auto-trust if the dialog mentions dangerous operations.
// Uses \b so garbled TUI text ("forkeyboardshortcuts") doesn't false-positive.
// In garbled text, \b doesn't match between concatenated words — that's fine:
// Claude Code's trust dialog content is fixed and won't contain these keywords.
const TRUST_EXCLUSION_KEYWORDS =
  /\b(delet|remov|credential|secret|password|key|token|destro|format|drop)/i;

// --- Consolidated per-agent tracking state ---
// Groups all per-agent Maps into one to prevent cleanup leaks.
interface AgentTrackingState {
  autoTrustTimer?: ReturnType<typeof setTimeout>;
  autoTrustCooldown?: ReturnType<typeof setTimeout>;
  lastAutoTrustCheckAt?: number;
  autoTrustAcceptedAt?: number;
  lastDataAt?: number;
  lastIdleResetAt?: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  outputTailBuffer: string;
  decoder: TextDecoder;
  lastAnalysisAt?: number;
  pendingAnalysis?: ReturnType<typeof setTimeout>;
  pendingAnalysisDueAt?: number;
}

const agentStates = new Map<string, AgentTrackingState>();

function getAgentState(agentId: string): AgentTrackingState {
  let state = agentStates.get(agentId);
  if (!state) {
    state = { outputTailBuffer: '', decoder: new TextDecoder() };
    agentStates.set(agentId, state);
  }
  return state;
}

const POST_AUTO_TRUST_SETTLE_MS = 1_000;

function isAutoTrustPending(agentId: string): boolean {
  const state = agentStates.get(agentId);
  if (!state) return false;
  return state.autoTrustTimer !== undefined || state.autoTrustCooldown !== undefined;
}

/** True while auto-trust is handling or settling a dialog for this agent.
 *  Covers both the pending phase (timer scheduled, Enter not yet sent) and
 *  the settling phase (Enter sent, agent still initializing).
 *  Auto-send should wait until this returns false.
 *  Note: cleans up expired entries as a side effect to avoid a separate timer. */
export function isAutoTrustSettling(agentId: string): boolean {
  if (isAutoTrustPending(agentId)) return true;
  const state = agentStates.get(agentId);
  if (!state?.autoTrustAcceptedAt) return false;
  if (Date.now() - state.autoTrustAcceptedAt >= POST_AUTO_TRUST_SETTLE_MS) {
    state.autoTrustAcceptedAt = undefined;
    return false;
  }
  return true;
}

function clearAutoTrustState(agentId: string): void {
  const state = agentStates.get(agentId);
  if (!state) return;
  state.lastAutoTrustCheckAt = undefined;
  state.autoTrustAcceptedAt = undefined;
  if (state.autoTrustTimer !== undefined) {
    clearTimeout(state.autoTrustTimer);
    state.autoTrustTimer = undefined;
  }
  if (state.autoTrustCooldown !== undefined) {
    clearTimeout(state.autoTrustCooldown);
    state.autoTrustCooldown = undefined;
  }
}

export type TaskDotStatus = 'busy' | 'waiting' | 'ready' | 'review';
export type TaskAttentionState = 'idle' | 'active' | 'needs_input' | 'error' | 'ready';

// --- Prompt detection helpers ---

/** Strip ANSI escape sequences (CSI, OSC, and single-char escapes) from terminal output. */
export function stripAnsi(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g,
    '',
  );
}

/**
 * Patterns that indicate the agent is waiting for user input (i.e. idle).
 * Each regex is tested against the last non-empty line of stripped output.
 *
 * - Claude Code prompt: ends with ❯ (possibly with trailing whitespace)
 * - Common shell prompts: $, %, #, >
 * - Y/n confirmation prompts
 */
const PROMPT_PATTERNS: RegExp[] = [
  /❯\s*$/, // Claude Code prompt
  /›\s*$/, // Codex CLI prompt
  /(?:^|\s)\$\s*$/, // bash/zsh dollar prompt (preceded by whitespace or BOL)
  /(?:^|\s)%\s*$/, // zsh percent prompt
  /(?:^|\s)#\s*$/, // root prompt
  /\[Y\/n\]\s*$/i, // Y/n confirmation
  /\[y\/N\]\s*$/i, // y/N confirmation
];

/** Returns true if `line` looks like a prompt waiting for input. */
function looksLikePrompt(line: string): boolean {
  const stripped = stripAnsi(line).trimEnd();
  if (stripped.length === 0) return false;
  return PROMPT_PATTERNS.some((re) => re.test(stripped));
}

/**
 * Patterns for known agent main input prompts (ready for a new task).
 * Tested against the stripped data chunk (not a single line), because TUI
 * apps like Claude Code use cursor positioning instead of newlines.
 */
const AGENT_READY_TAIL_PATTERNS: RegExp[] = [
  /❯/, // Claude Code
  /›/, // Codex CLI
];

/** Check stripped output for known agent prompt characters.
 *  Only checks the tail of the chunk — the agent's main prompt renders near
 *  the end of the visible content, while TUI selection UIs place ❯ earlier in
 *  the render followed by option text and other choices.
 *  300 chars covers both Claude Code (❯ at the very end) and Copilot CLI
 *  (❯ ~200 chars from end — box border and a footer line appear below it). */
function chunkContainsAgentPrompt(stripped: string): boolean {
  if (stripped.length === 0) return false;
  const tail = stripped.slice(-300);
  return AGENT_READY_TAIL_PATTERNS.some((re) => re.test(tail));
}

// --- Agent ready event callbacks ---
// Fired from markAgentOutput when a main prompt is detected in a PTY chunk.
const agentReadyCallbacks = new Map<string, () => void>();

/** Register a callback that fires once when the agent's main prompt is detected. */
export function onAgentReady(agentId: string, callback: () => void): void {
  agentReadyCallbacks.set(agentId, callback);
}

/** Remove a pending agent-ready callback. */
export function offAgentReady(agentId: string): void {
  agentReadyCallbacks.delete(agentId);
}

/** Fire the one-shot agentReady callback if the tail buffer shows a known agent prompt. */
function tryFireAgentReadyCallback(agentId: string): void {
  if (!agentReadyCallbacks.has(agentId)) return;
  const state = agentStates.get(agentId);
  const rawTail = state?.outputTailBuffer ?? '';
  const tailStripped = stripAnsi(rawTail)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (chunkContainsAgentPrompt(tailStripped)) {
    const cb = agentReadyCallbacks.get(agentId);
    agentReadyCallbacks.delete(agentId);
    if (cb) cb();
  }
}

/**
 * Normalize terminal output for quiescence comparison.
 * Strips ANSI, removes control characters, collapses whitespace so that
 * cursor repositioning and status bar redraws don't register as changes.
 */
export function normalizeForComparison(text: string): string {
  return (
    stripAnsi(text)
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Like normalizeForComparison, but only considers the most recently rendered
 * screen frame.  TUI agents (Copilot CLI, Codex CLI) redraw the full screen on
 * every frame using cursor-positioning escape codes without a screen-clear
 * between frames.  The raw tail buffer therefore grows with each redraw even
 * when the visible content is identical, making `normalizeForComparison(tail)`
 * produce a longer string on every call — which breaks the quiescence snapshot
 * comparison in PromptInput.
 *
 * This function finds the last occurrence of a "frame start" marker
 * (cursor-to-row-1 or screen-clear sequence) and normalizes only the content
 * from that point on.  Consecutive redraws of the same screen therefore
 * produce identical normalized strings, allowing the stability check to pass.
 *
 * Falls back to normalizeForComparison(text) when no frame-start marker is
 * found (regular line-oriented terminal output).
 */
export function normalizeCurrentFrame(rawTail: string): string {
  // Matches the beginning of a new render cycle:
  //   \x1b[H        — cursor home (row 1, col 1)
  //   \x1b[1;NNH    — cursor to row 1, any column
  //   \x1b[2J       — erase entire display
  //   \x1b[?1049h   — enter alternate screen buffer
  // eslint-disable-next-line no-control-regex
  const frameStartRe = /\x1b\[(?:H|1;\d+H|2J|\?1049h)/g;
  let frameStart = -1;
  let m: RegExpExecArray | null;
  while ((m = frameStartRe.exec(rawTail)) !== null) {
    frameStart = m.index;
  }
  if (frameStart >= 0) {
    return normalizeForComparison(rawTail.slice(frameStart));
  }
  // No frame-start marker found (e.g. cursor-up redraws).  Each redraw appends
  // identical visible content so the full normalized string grows without bound.
  // Taking a fixed-size suffix stabilises the comparison: once two consecutive
  // frames have accumulated the last SUFFIX_LEN chars are always the same
  // repeating frame content.
  const SUFFIX_LEN = 1000;
  return normalizeForComparison(rawTail).slice(-SUFFIX_LEN);
}

/** Patterns indicating the terminal is asking a question — do NOT auto-send.
 *  Includes both normal-text and TUI-garbled variants (no spaces between words
 *  after ANSI cursor-positioning sequences are stripped). */
const QUESTION_PATTERNS: RegExp[] = [
  /\[Y\/n\]\s*$/i,
  /\[y\/N\]\s*$/i,
  /\(y(?:es)?\/n(?:o)?\)\s*$/i,
  /\btrust\b.*\?/i,
  /\bupdate\b.*\?/i,
  /\bproceed\b.*\?/i,
  /\boverwrite\b.*\?/i,
  /\bcontinue\b.*\?/i,
  /\ballow\b.*\?/i,
  /Do you want to/i,
  /Would you like to/i,
  /Are you sure/i,
  // TUI-garbled: words concatenated after ANSI strip ("Itrustthisfolder").
  /trust.*folder/i,
  // Copilot CLI header: "Confirm folder trust" (normal and TUI-garbled "Confirmfoldertrust").
  /confirm.*folder.*trust/i,
];

/** Find the byte offset just after the last screen-clearing ANSI sequence
 *  that has non-empty visible content after it.  Returns -1 when none is found.
 *
 *  Full-screen TUI apps (Ink, etc.) erase their display before every redraw.
 *  We walk backward through all clears and pick the last one that already has
 *  visible text after it.  This prevents a mid-redraw race where the most
 *  recent \x1b[2J was just emitted but the TUI hasn't written the new render
 *  yet — in that window the post-clear content is empty, causing a false
 *  negative that lets auto-send fire into an active dialog. */
function findLastNonEmptyScreenClear(raw: string): number {
  // \x1b[2J  – erase entire display (most common full-screen clear)
  // \x1b[?1049h – enter alternate screen buffer (fresh context on TUI start)
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\[2J|\x1b\[\?1049h/g;
  const indices: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    indices.push(m.index + m[0].length);
  }
  // Walk from newest to oldest, return the first (newest) clear with content.
  for (let i = indices.length - 1; i >= 0; i--) {
    if (stripAnsi(raw.slice(indices[i])).trim().length > 0) {
      return indices[i];
    }
  }
  return -1;
}

/** True when recent output contains a question or confirmation prompt.
 *  Checks ALL recent lines because TUI dialogs render the question above
 *  selection options — the question text may not be the last line.
 *
 *  For full-screen TUI agents (e.g. Copilot CLI) that clear+redraw their
 *  display on every render cycle, only output *after* the most recent
 *  COMPLETE render is analysed.  This prevents stale question text from a
 *  previous render from keeping the question flag set indefinitely after the
 *  agent has returned to its prompt.  "Most recent complete render" means the
 *  last screen-clear that has non-empty visible content after it — skipping
 *  mid-redraw clears where the new render hasn't been written yet.
 *
 *  For agents that do not emit screen-clear sequences the full tail buffer
 *  is used, preserving the existing behaviour. */
export function looksLikeQuestion(tail: string): boolean {
  // Restrict analysis to content after the last COMPLETE screen clear.
  const clearIdx = findLastNonEmptyScreenClear(tail);
  const analysisTail = clearIdx >= 0 ? tail.slice(clearIdx) : tail;

  const visible = stripAnsi(analysisTail);
  // Use the full visible content — do NOT slice to a small suffix.
  // TUI agents (Copilot CLI, Codex CLI) use cursor positioning instead of
  // newlines, so all rendered text collapses to one long string.  A 500-char
  // window only captures the selection options (❯ Yes / No) and misses the
  // question header ("Confirm folder trust", "Do you trust…?") that appears
  // earlier in the visual layout.  Visible content is always bounded by
  // TAIL_BUFFER_MAX raw bytes so scanning the full string is fast.
  const chunk = visible;
  const lines = chunk.split(/\r?\n/).filter((l) => l.trim().length > 0);

  if (lines.length === 0) {
    return false;
  }

  // --- Trust-dialog fast path ---
  // Check the current-frame raw bytes for trust phrases before any ANSI stripping.
  // Trust dialog text is written as atomic UTF-8 — ANSI codes appear between words,
  // not inside them, so a raw search reliably finds them.  Use analysisTail (not
  // full tail) to avoid matching stale trust-dialog content from old TUI frames
  // that have already been overwritten by a screen-clear.
  const rawLower = analysisTail.toLowerCase();
  if (rawLower.includes('confirm folder trust') || rawLower.includes('do you trust')) {
    // Bare ❯ on its own line means the dialog was already answered.
    const hasBarePromptLineRaw = lines.some((l) => /^\s*[❯›]\s*$/.test(l.trimEnd()));
    if (!hasBarePromptLineRaw) {
      return true;
    }
  }

  // Check trust patterns against the ANSI-stripped lines BEFORE the bare-❯ suppression.
  // TUI agents (Ink) render the trust dialog using cursor-positioning — after ANSI stripping
  // all content collapses to one long string.  If the PTY buffer was captured
  // mid-frame (e.g. right after the selection-cursor ❯ was written but before
  // the surrounding box-border was completed), that string can end with ❯,
  // which would normally trigger the bare-❯ suppression and return false.
  // Trust dialogs are high-confidence: if the visible content contains a trust
  // pattern, we return true immediately — UNLESS a bare-❯-only line is present
  // (which would mean the question was already answered and the agent is back
  // at its main prompt with old trust-dialog text still in the buffer).
  const hasTrustContent = lines.some((line) => {
    const trimmed = line.trimEnd();
    return TRUST_PATTERNS.some((re) => re.test(trimmed));
  });
  if (hasTrustContent) {
    // A bare ❯ on its own line means the agent returned to its prompt after
    // the trust dialog was already handled (old text lingers in the tail buffer).
    const hasBarePromptLine = lines.some((l) => /^\s*[❯›]\s*$/.test(l.trimEnd()));
    if (!hasBarePromptLine) {
      return true;
    }
  }

  // If a known agent main prompt (❯ or ›) is visible on its own line or at
  // the end of a line, any earlier question/trust dialog text has already been
  // answered — not a live question.
  // TUI selection UIs also use ❯, but always followed by option text
  // (e.g. "❯ Yes"), so they won't produce a bare ❯ line or end-of-line ❯.
  //
  // We scan the last 8 lines (not just the last 3) because some TUI agents
  // (e.g. Codex CLI) render a multi-line footer/help bar *below* the prompt,
  // pushing the bare ❯/› line several positions up from the end.
  const lastLine = lines[lines.length - 1].trimEnd();
  const recentLines = lines.slice(-8);
  if (recentLines.some((l) => /^\s*[❯›]\s*$/.test(l.trimEnd())) || /[❯›]\s*$/.test(lastLine)) {
    return false;
  }

  return lines.some((line) => {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) return false;
    return QUESTION_PATTERNS.some((re) => re.test(trimmed));
  });
}

/** True when the tail buffer's question patterns are entirely from trust/allow
 *  dialogs that auto-trust will handle. Returns false when:
 *  - autoTrustFolders is disabled
 *  - the tail doesn't contain trust dialog patterns
 *  - exclusion keywords (delete, password, etc.) are present
 *  - non-trust question patterns are also found in the tail */
export function isTrustQuestionAutoHandled(tail: string): boolean {
  if (!store.autoTrustFolders) return false;
  if (!looksLikeTrustDialog(tail)) return false;
  const visible = stripAnsi(tail); // full visible — see looksLikeQuestion for rationale
  if (TRUST_EXCLUSION_KEYWORDS.test(visible)) return false;
  const lines = visible.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return !lines.some((line) => {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) return false;
    // Lines matching trust patterns are handled by auto-trust — skip them.
    if (TRUST_PATTERNS.some((re) => re.test(trimmed))) return false;
    // If a line matches a non-trust question pattern, this is NOT only a trust question.
    return QUESTION_PATTERNS.some((re) => re.test(trimmed));
  });
}

/** True when recent output contains a trust or permission dialog. */
function looksLikeTrustDialog(tail: string): boolean {
  // Raw-text fast path: trust dialog phrases are literal UTF-8 in the PTY stream.
  // ANSI codes appear between/around words but not splitting individual words, so a
  // case-insensitive raw search reliably finds them without stripping first.
  const rawLower = tail.toLowerCase();
  if (rawLower.includes('confirm folder trust') || rawLower.includes('do you trust')) {
    return true;
  }

  const visible = stripAnsi(tail); // full visible — see looksLikeQuestion for rationale
  const lines = visible.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.some((line) => TRUST_PATTERNS.some((re) => re.test(line.trimEnd())));
}

// --- Agent question tracking ---
// Reactive set of agent IDs that currently have a question/dialog in their terminal.
const [questionAgents, setQuestionAgents] = createSignal<Set<string>>(new Set());

/** True when the agent's terminal is showing a question or confirmation dialog. */
export function isAgentAskingQuestion(agentId: string): boolean {
  return questionAgents().has(agentId);
}

function updateQuestionState(agentId: string, hasQuestion: boolean): void {
  setQuestionAgents((prev) => {
    if (hasQuestion === prev.has(agentId)) return prev;
    const next = new Set(prev);
    if (hasQuestion) next.add(agentId);
    else next.delete(agentId);
    return next;
  });
}

// --- Agent activity tracking ---
// Reactive set of agent IDs considered "active" (updated on coarser schedule).
const [activeAgents, setActiveAgents] = createSignal<Set<string>>(new Set());

// How long after the last data event before transitioning back to idle.
// AI agents routinely go silent for 10-30s during normal work (thinking,
// API calls, tool use), so this needs to be long enough to cover those pauses.
const IDLE_TIMEOUT_MS = 15_000;
// Throttle reactive updates while already active.
const THROTTLE_MS = 1_000;

// Tail buffer per agent — keeps the last N bytes of PTY output for prompt matching.
// Must be large enough to hold a full TUI dialog render (with ANSI codes) so that
// question text at the top of the dialog isn't truncated away.  16 KB is
// comfortable for multi-frame Ink TUI renders (~1.5 KB/frame) plus any startup
// banner that Copilot CLI emits before entering the alternate screen.
const TAIL_BUFFER_MAX = 16_384;

// Throttle for background (non-active) auto-trust checks so we don't run
// ANSI strip + regex on every PTY chunk from every agent.
const AUTO_TRUST_BG_THROTTLE_MS = 500;

// Per-agent timestamp of last expensive analysis (question/prompt detection).
const ACTIVE_ANALYSIS_INTERVAL_MS = 200;
const BACKGROUND_ANALYSIS_INTERVAL_MS = 1_200;

function addToActive(agentId: string): void {
  setActiveAgents((s) => {
    if (s.has(agentId)) return s;
    const next = new Set(s);
    next.add(agentId);
    return next;
  });
}

function removeFromActive(agentId: string): void {
  setActiveAgents((s) => {
    if (!s.has(agentId)) return s;
    const next = new Set(s);
    next.delete(agentId);
    return next;
  });
}

function resetIdleTimer(agentId: string): void {
  const state = getAgentState(agentId);
  state.lastIdleResetAt = Date.now();
  if (state.idleTimer !== undefined) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    removeFromActive(agentId);
    state.idleTimer = undefined;
  }, IDLE_TIMEOUT_MS);
}

function cancelPendingAnalysis(state: AgentTrackingState): void {
  if (state.pendingAnalysis !== undefined) {
    clearTimeout(state.pendingAnalysis);
    state.pendingAnalysis = undefined;
  }
  state.pendingAnalysisDueAt = undefined;
}

function runAgentAnalysis(agentId: string, now: number): void {
  const state = getAgentState(agentId);
  cancelPendingAnalysis(state);
  state.lastAnalysisAt = now;
  analyzeAgentOutput(agentId);
}

function scheduleAgentAnalysis(agentId: string, intervalMs: number, now: number): void {
  const state = getAgentState(agentId);
  const lastAnalysis = state.lastAnalysisAt ?? 0;
  if (now - lastAnalysis >= intervalMs) {
    runAgentAnalysis(agentId, now);
    return;
  }

  const delay = intervalMs - (now - lastAnalysis);
  const dueAt = now + delay;
  if (
    state.pendingAnalysis !== undefined &&
    state.pendingAnalysisDueAt !== undefined &&
    state.pendingAnalysisDueAt <= dueAt
  ) {
    return;
  }

  cancelPendingAnalysis(state);
  state.pendingAnalysisDueAt = dueAt;
  state.pendingAnalysis = setTimeout(() => {
    runAgentAnalysis(agentId, Date.now());
  }, delay);
}

/** Mark an agent as active when it is first spawned.
 *  Ensures agents start as "busy" before any PTY data arrives. */
export function markAgentSpawned(agentId: string): void {
  const state = getAgentState(agentId);
  state.outputTailBuffer = '';
  clearAutoTrustState(agentId);
  state.lastAnalysisAt = undefined;
  cancelPendingAnalysis(state);
  state.lastDataAt = Date.now();
  addToActive(agentId);
  resetIdleTimer(agentId);
}

/** Try to auto-accept trust/permission dialogs for any agent (active or background).
 *  Lightweight check that only runs trust-specific patterns. */
function tryAutoTrust(agentId: string, rawTail: string): boolean {
  if (!store.autoTrustFolders || isAutoTrustPending(agentId)) {
    return false;
  }
  if (!looksLikeTrustDialog(rawTail)) {
    return false;
  }
  if (TRUST_EXCLUSION_KEYWORDS.test(stripAnsi(rawTail))) {
    return false;
  }

  const state = getAgentState(agentId);
  // Short delay to let the TUI finish rendering before sending Enter.
  state.autoTrustTimer = setTimeout(() => {
    state.autoTrustTimer = undefined;
    // Clear stale trust-dialog content (including ❯ selection cursor) so
    // chunkContainsAgentPrompt only fires on the agent's real prompt.
    state.outputTailBuffer = '';
    // Deregister the agent-ready callback so the fast path (immediate ❯
    // detection) is disabled.  The agent may render ❯ before it's fully
    // initialized — the quiescence fallback (1500ms of stable output)
    // is more reliable after trust acceptance.
    agentReadyCallbacks.delete(agentId);
    // Start the settling period — blocks auto-send for POST_AUTO_TRUST_SETTLE_MS
    // to give slow-starting agents (e.g. Claude Code) time to fully initialize.
    state.autoTrustAcceptedAt = Date.now();
    invoke(IPC.WriteToAgent, { agentId, data: '\r' }).catch(() => {});
    // Cooldown: ignore trust patterns for 1s so the same dialog
    // isn't re-matched while the PTY output transitions.
    // (The tail buffer is cleared above, so re-detection is only possible
    // if the agent immediately re-shows a trust dialog.)
    state.autoTrustCooldown = setTimeout(() => {
      state.autoTrustCooldown = undefined;
    }, 1_000);
  }, 50);
  return true;
}

/** Run expensive prompt/question/agent-ready detection on the tail buffer.
 *  Called at most every ANALYSIS_INTERVAL_MS (200ms) per agent. */
function analyzeAgentOutput(agentId: string): void {
  const state = getAgentState(agentId);
  const rawTail = state.outputTailBuffer;
  let hasQuestion = looksLikeQuestion(rawTail);

  // Suppress question state for trust dialogs when auto-trust is enabled —
  // whether we just scheduled auto-trust or it's already pending/in cooldown.
  // Without this, subsequent analysis calls re-detect the stale dialog text in
  // the tail buffer and set hasQuestion=true, which disables the prompt
  // textarea and steals focus to the terminal.
  if (hasQuestion && store.autoTrustFolders) {
    if (looksLikeTrustDialog(rawTail) && !TRUST_EXCLUSION_KEYWORDS.test(stripAnsi(rawTail))) {
      // Auto-trust may not have fired yet if this is the first analysis for
      // an active task that just became visible — trigger it now.
      tryAutoTrust(agentId, rawTail);
      hasQuestion = false;
    }
  }

  updateQuestionState(agentId, hasQuestion);

  // Agent-ready prompt scanning. Uses the tail buffer (always current) so
  // throttled/trailing calls don't miss prompts from intermediate chunks.
  // Guard: don't fire if the tail buffer contains a question — TUI selection
  // UIs (e.g. "trust this folder?") also use ❯ as a cursor.
  // Also skip while auto-trust Enter is scheduled (50ms window) — the ❯ in
  // the selection UI is a false positive.  After the timer fires, the tail
  // buffer is cleared so only the agent's real prompt can trigger this.
  if (!hasQuestion && state.autoTrustTimer === undefined) tryFireAgentReadyCallback(agentId);
}

/** Call this from the TerminalView Data handler with the raw PTY bytes.
 *  Detects prompt patterns to immediately mark agents idle instead of
 *  waiting for the full idle timeout. */
export function markAgentOutput(agentId: string, data: Uint8Array, taskId?: string): void {
  const now = Date.now();
  const state = getAgentState(agentId);
  state.lastDataAt = now;

  const text = state.decoder.decode(data, { stream: true });
  const combined = state.outputTailBuffer + text;
  state.outputTailBuffer =
    combined.length > TAIL_BUFFER_MAX
      ? combined.slice(combined.length - TAIL_BUFFER_MAX)
      : combined;

  // Expensive analysis (regex, ANSI strip) now runs for all task agents, with a
  // slower cadence for background tasks so off-screen attention still updates.
  const isActiveTask = !taskId || taskId === store.activeTaskId;

  // Auto-trust runs for ALL agents (including background tasks) so trust
  // dialogs are accepted immediately without needing to switch to the task.
  // Active-task agents also get full analysis; background agents keep a faster
  // trust-only path plus a slower full analysis path for attention updates.
  if (store.autoTrustFolders && !isAutoTrustPending(agentId) && !isActiveTask) {
    const lastCheck = state.lastAutoTrustCheckAt ?? 0;
    if (now - lastCheck >= AUTO_TRUST_BG_THROTTLE_MS) {
      state.lastAutoTrustCheckAt = now;
      tryAutoTrust(agentId, state.outputTailBuffer);
    }
  }

  scheduleAgentAnalysis(
    agentId,
    isActiveTask ? ACTIVE_ANALYSIS_INTERVAL_MS : BACKGROUND_ANALYSIS_INTERVAL_MS,
    now,
  );

  // Extract last non-empty line from recent output for prompt matching.
  // This check is UNTHROTTLED — it's cheap (single line, 6 patterns) and
  // important for responsive idle detection.
  const tail = combined.slice(-200);
  let lastLine = '';
  let searchEnd = tail.length;
  while (searchEnd > 0) {
    const nlIdx = tail.lastIndexOf('\n', searchEnd - 1);
    const candidate = tail.slice(nlIdx + 1, searchEnd).trim();
    if (candidate.length > 0) {
      lastLine = candidate;
      break;
    }
    searchEnd = nlIdx >= 0 ? nlIdx : 0;
  }

  if (looksLikePrompt(lastLine)) {
    // Prompt detected — agent is idle. Remove from active set immediately.
    //
    // NOTE: do NOT cancel pendingAnalysis here.  TUI agents (Copilot CLI,
    // Codex) use Ink which positions the ❯ selection cursor in a separate
    // PTY chunk BEFORE the surrounding dialog text.  If we cancelled the
    // trailing analyzeAgentOutput call at that point, the trust dialog would
    // never be detected by looksLikeQuestion, tryAutoTrust would never run,
    // isAutoTrustSettling would stay false, and the initial prompt would get
    // sent into the active trust dialog.  Allow the trailing analysis to run
    // so question/trust state is always up-to-date.

    // Preserve real question state even when the prompt arrives inside the
    // analysis throttle window (common for background Y/n confirmations).
    // Without this fast-path check, cancelling the pending analysis would drop
    // the question signal and the task would incorrectly look idle.
    const hasQuestion = looksLikeQuestion(state.outputTailBuffer);
    updateQuestionState(agentId, hasQuestion);

    // Fire the agentReady callback (used by PromptInput auto-send).
    // The chunkContainsAgentPrompt guard inside tryFireAgentReadyCallback
    // ensures shell prompts ($, %) don't trigger it.
    tryFireAgentReadyCallback(agentId);

    if (state.idleTimer !== undefined) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
    removeFromActive(agentId);
    return;
  }

  // Non-prompt output — agent is producing real work.
  if (activeAgents().has(agentId)) {
    const lastReset = state.lastIdleResetAt ?? 0;
    if (now - lastReset < THROTTLE_MS) return;
    resetIdleTimer(agentId);
    return;
  }

  addToActive(agentId);
  resetIdleTimer(agentId);
}

/** Return the last ~4096 chars of raw PTY output for `agentId`. */
export function getAgentOutputTail(agentId: string): string {
  return agentStates.get(agentId)?.outputTailBuffer ?? '';
}

/** True when the agent is NOT producing output (e.g. sitting at a prompt). */
export function isAgentIdle(agentId: string): boolean {
  return !activeAgents().has(agentId);
}

/** Lightweight busy marker — adds to active set + resets idle timer.
 *  Unlike markAgentSpawned this preserves the output tail buffer. */
export function markAgentBusy(agentId: string): void {
  addToActive(agentId);
  resetIdleTimer(agentId);
}

/** Clean up timers when an agent exits. */
export function clearAgentActivity(agentId: string): void {
  const state = agentStates.get(agentId);
  if (state) {
    clearAutoTrustState(agentId);
    if (state.idleTimer !== undefined) clearTimeout(state.idleTimer);
    cancelPendingAnalysis(state);
  }
  agentStates.delete(agentId);
  agentReadyCallbacks.delete(agentId);
  removeFromActive(agentId);
  updateQuestionState(agentId, false);
}

// --- Derived status ---

function isTaskReady(taskId: string): boolean {
  const git = store.taskGitStatus[taskId];
  return Boolean(git?.has_committed_changes && !git?.has_uncommitted_changes);
}

function hasTaskAgentError(taskId: string): boolean {
  const task = store.tasks[taskId];
  if (!task) return false;
  return task.agentIds.some((id) => {
    const agent = store.agents[id];
    if (agent?.status !== 'exited') return false;
    return agent.exitCode !== 0 || agent.signal !== null;
  });
}

export function getTaskAttentionState(taskId: string): TaskAttentionState {
  const task = store.tasks[taskId];
  if (!task) return 'idle';

  if (hasTaskAgentError(taskId)) return 'error';

  const active = activeAgents(); // reactive read
  const hasQuestion = task.agentIds.some((id) => {
    const agent = store.agents[id];
    return agent?.status === 'running' && isAgentAskingQuestion(id);
  });
  if (hasQuestion) return 'needs_input';

  const hasActive = task.agentIds.some((id) => {
    const agent = store.agents[id];
    return agent?.status === 'running' && active.has(id);
  });
  if (hasActive) return 'active';

  if (isTaskReady(taskId)) return 'ready';
  return 'idle';
}

export function taskNeedsAttention(taskId: string): boolean {
  const attention = getTaskAttentionState(taskId);
  return attention === 'active' || attention === 'needs_input' || attention === 'error';
}

export function getTaskDotStatus(taskId: string): TaskDotStatus {
  const task = store.tasks[taskId];
  if (!task) return 'waiting';
  const active = activeAgents(); // reactive read
  const hasActive = task.agentIds.some((id) => {
    const a = store.agents[id];
    return a?.status === 'running' && active.has(id);
  });
  if (hasActive) return 'busy';

  const steps = task.stepsContent;
  if (steps && steps.length > 0) {
    const latest = steps[steps.length - 1];
    if (latest.status === 'awaiting_review') return 'review';
  }

  if (isTaskReady(taskId)) return 'ready';
  return 'waiting';
}

// --- Git status polling ---

async function refreshTaskGitStatus(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task) return;

  try {
    const status = await invoke<WorktreeStatus>(IPC.GetWorktreeStatus, {
      worktreePath: task.worktreePath,
      baseBranch: task.baseBranch,
    });
    setStore('taskGitStatus', taskId, status);
  } catch {
    // Worktree may not exist yet or was removed — ignore
  }
}

let isRefreshingAll = false;
let refreshAllStartedAt = 0;

/** Refresh git status for inactive tasks (active task is handled by its own 5s timer).
 *  Limits concurrency to avoid spawning too many parallel git processes. */
export async function refreshAllTaskGitStatus(): Promise<void> {
  if (isRefreshingAll && Date.now() - refreshAllStartedAt < 60_000) return;
  isRefreshingAll = true;
  refreshAllStartedAt = Date.now();
  try {
    const taskIds = store.taskOrder;
    const active = activeAgents();
    const currentTaskId = store.activeTaskId;
    const toRefresh = taskIds.filter((taskId) => {
      // Active task is covered by the faster refreshActiveTaskGitStatus timer
      if (taskId === currentTaskId) return false;
      const task = store.tasks[taskId];
      if (!task) return false;
      return !task.agentIds.some((id) => {
        const a = store.agents[id];
        return a?.status === 'running' && active.has(id);
      });
    });

    // Process in batches of 4 to limit concurrent git processes
    const BATCH_SIZE = 4;
    for (let i = 0; i < toRefresh.length; i += BATCH_SIZE) {
      const batch = toRefresh.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(batch.map((taskId) => refreshTaskGitStatus(taskId)));
    }
  } finally {
    isRefreshingAll = false;
  }
}

/** Refresh git status for the currently active task only. */
async function refreshActiveTaskGitStatus(): Promise<void> {
  const taskId = store.activeTaskId;
  if (!taskId) return;
  await refreshTaskGitStatus(taskId);
}

/** Refresh git status for a single task (e.g. after agent exits). */
export function refreshTaskStatus(taskId: string): void {
  refreshTaskGitStatus(taskId);
}

let allTasksTimer: ReturnType<typeof setInterval> | null = null;
let activeTaskTimer: ReturnType<typeof setInterval> | null = null;
let lastPollingTaskCount = 0;

function computeAllTasksInterval(): number {
  const taskCount = store.taskOrder.length;
  return Math.min(120_000, 30_000 + Math.max(0, taskCount - 3) * 5_000);
}

export function startTaskStatusPolling(): void {
  if (allTasksTimer || activeTaskTimer) return;
  // Active task polls every 5s for responsive UI
  activeTaskTimer = setInterval(refreshActiveTaskGitStatus, 5_000);
  // Scale interval: 30s base + 5s per additional task beyond 3
  lastPollingTaskCount = store.taskOrder.length;
  allTasksTimer = setInterval(refreshAllTaskGitStatus, computeAllTasksInterval());
  // Run once immediately
  refreshActiveTaskGitStatus();
  refreshAllTaskGitStatus();
}

/** Call when tasks are added/removed to recalculate the all-tasks polling interval. */
export function rescheduleTaskStatusPolling(): void {
  if (!allTasksTimer) return;
  const currentCount = store.taskOrder.length;
  if (currentCount === lastPollingTaskCount) return;
  lastPollingTaskCount = currentCount;
  clearInterval(allTasksTimer);
  allTasksTimer = setInterval(refreshAllTaskGitStatus, computeAllTasksInterval());
}

export function stopTaskStatusPolling(): void {
  if (allTasksTimer) {
    clearInterval(allTasksTimer);
    allTasksTimer = null;
  }
  if (activeTaskTimer) {
    clearInterval(activeTaskTimer);
    activeTaskTimer = null;
  }
  lastPollingTaskCount = 0;
}
