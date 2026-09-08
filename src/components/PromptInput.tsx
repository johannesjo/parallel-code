import { createSignal, createEffect, on, Show, onMount, onCleanup, untrack, batch } from 'solid-js';
import { fireAndForget, invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import {
  store,
  sendPrompt,
  setInitialPrompt,
  clearInitialPrompt,
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
  isAgentTrustQuestionAutoHandled,
  isAutoTrustSettling,
  isAgentAskingQuestion,
  isAgentIdle,
  setTaskLastInputAt,
  isPanelFocused,
  setTaskControl,
  markTaskUserActivity,
  setTaskPromptDraftActive,
  setTaskTerminalInputPending,
  showNotification,
} from '../store/store';
import { clearStagedNotification, setTaskTerminalInputPendingFromQuestion } from '../store/tasks';
import { isLandedTaskState } from '../store/landing';
import { processAutoFireTick } from './autofire-tick';
import {
  resolveAutoSendVerifyOutcome,
  shouldAckInitialPromptDelivery,
  shouldHandoffCoordinatorQuestion,
  shouldRendererAutoSendInitialPrompt,
} from './prompt-control';
import {
  isStartupBlockingAutoSend,
  shouldAbortInitialPromptAfterTimeout,
} from './prompt-autosend-readiness';
import { hasUserPromptDraftText } from './prompt-draft';
import { pollUntilPromptAppearsInOutput } from './prompt-verify';
import type { StagedNotification } from '../store/types';
import { debug, warn as logWarn } from '../lib/log';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';

export interface PromptInputHandle {
  getText: () => string;
  setText: (value: string) => void;
}

interface PromptInputProps {
  taskId: string;
  taskName: string;
  agentId: string;
  coordinatedBy?: string;
  coordinatorMode?: boolean;
  controlledBy?: 'human' | 'coordinator';
  stagedNotification?: StagedNotification;
  nowMs?: () => number;
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
// How many times to restart the auto-send loop when the prompt echo is not
// confirmed.  Each retry re-runs the full stability-check cycle, so 2 retries
// means 3 total attempts.
const AUTO_SEND_MAX_RETRIES = 2;
const PROMPT_MARKER_SCAN_CHARS = 500;
// 5s covers the typical round-trip from send → pty echo; 40 chars is enough to
// uniquely identify the prompt without risking a false match on short snippets.
const PROMPT_ECHO_HANDOFF_SUPPRESS_MS = 5_000;

/** True when auto-send should be blocked by a question in the output.
 *  Trust-dialog questions are NOT blocking when auto-trust handles them. */
const isQuestionBlockingAutoSend = (agentId: string, tail: string): boolean =>
  looksLikeQuestion(tail) && !isAgentTrustQuestionAutoHandled(agentId, tail);

export function PromptInput(props: PromptInputProps) {
  const [text, setText] = createSignal('');
  const [sending, setSending] = createSignal(false);
  const [autoSentInitialPrompt, setAutoSentInitialPrompt] = createSignal<string | null>(null);
  // Incremented when promptAppearedInOutput fails so the auto-send createEffect
  // restarts a fresh attempt rather than treating the prompt as delivered.
  const [autoSendRetry, setAutoSendRetry] = createSignal(0);
  let cleanupAutoSend: (() => void) | undefined;

  // Debug: log whenever controlledBy changes (verbose-gated; forwards to /tmp/out via main process)
  createEffect(() => {
    const cb = props.controlledBy;
    const coordBy = props.coordinatedBy;
    if (cb !== undefined || coordBy !== undefined) {
      debug('ctrl', 'controlledBy changed', {
        controlledBy: cb,
        coordinatedBy: coordBy,
        taskId: props.taskId,
        shouldBeDisabled: false,
      });
      // Check actual DOM state after all render effects have run
      setTimeout(() => {
        if (textareaRef) {
          const domDisabled = textareaRef.disabled;
          // The textarea is intentionally never hard-disabled (see the textarea
          // below): typing stays available even while a question is active so
          // the box can't latch permanently uneditable.
          const expected = false;
          if (domDisabled !== expected) {
            logWarn('ctrl', 'textarea disabled mismatch — DOM vs expected', {
              domDisabled,
              expected,
              controlledBy: cb,
              taskId: props.taskId,
            });
          } else {
            debug('ctrl', 'textarea disabled matches expected', {
              domDisabled,
              controlledBy: cb,
              taskId: props.taskId,
            });
          }
        }
      }, 0);
    }
  });

  createEffect(() => {
    autoSendRetry(); // track — incremented on failed echo-verification to restart this effect
    cleanupAutoSend?.();
    cleanupAutoSend = undefined;

    const ip = props.initialPrompt?.trim() ?? '';
    if (
      !shouldRendererAutoSendInitialPrompt({
        coordinatedBy: props.coordinatedBy,
        initialPrompt: props.initialPrompt,
      })
    ) {
      return;
    }

    const currentText = text().trim();
    if (currentText && currentText !== ip) return;
    setText(ip);
    setTaskPromptDraftActive(props.taskId, false);
    if (autoSentInitialPrompt() === ip) return;

    const agentId = props.agentId;
    const coordinatedBy = props.coordinatedBy;
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
      if (isStartupBlockingAutoSend(getAgentOutputTail(agentId))) return;
      cleanup();
      void handleSend('auto');
    }

    // --- FAST PATH: event from markAgentOutput ---
    // Fires when a known prompt pattern (❯, ›) is detected in PTY output.
    // The callback is one-shot (deleted after firing in markAgentOutput),
    // so we re-register when a question guard blocks to keep the fast path alive.
    function onReady() {
      if (cancelled) return;
      if (isQuestionBlockingAutoSend(agentId, getAgentOutputTail(agentId))) {
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
      if (isStartupBlockingAutoSend(getAgentOutputTail(agentId))) {
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
          if (isStartupBlockingAutoSend(tail)) {
            onAgentReady(agentId, onReady);
            return;
          }
          if (isQuestionBlockingAutoSend(agentId, tail)) {
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

      // Background/focus-hidden terminals may not populate the renderer tail
      // until the user switches to them. Coordinated sub-task assignments also
      // must not be silently abandoned; the coordinator is waiting for this
      // terminal call to start real work. Timeout is only an abort condition for
      // non-coordinated prompts once output is visible; otherwise keep polling.
      if (
        shouldAbortInitialPromptAfterTimeout({
          elapsedMs: elapsed,
          maxWaitMs: AUTOSEND_MAX_WAIT_MS,
          coordinatedBy,
          tail: getAgentOutputTail(agentId),
        })
      ) {
        cleanup();
        return;
      }
      if (elapsed < AUTOSEND_MIN_WAIT_MS) return;
      // After auto-trust acceptance, wait for the agent to fully initialize.
      if (isAutoTrustSettling(agentId)) return;

      const tail = getAgentOutputTail(agentId);
      if (!tail) return;
      if (isStartupBlockingAutoSend(tail)) {
        lastRawTail = tail;
        stableSince = 0;
        return;
      }

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
          if (!isQuestionBlockingAutoSend(agentId, tail)) {
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
      if (isQuestionBlockingAutoSend(agentId, tail)) {
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
    setTaskPromptDraftActive(props.taskId, true);
    untrack(() => props.onPrefillConsumed?.());
  });

  // --- Staged coordinator notification auto-fire ---
  let autoFireInterval: number | undefined;
  function executeAutoFire(staged: NonNullable<typeof props.stagedNotification>) {
    if (autoFireInterval !== undefined) {
      clearInterval(autoFireInterval);
      autoFireInterval = undefined;
    }
    const taskId = props.taskId;
    const agentId = props.agentId;
    void (async () => {
      try {
        await sendPrompt(taskId, agentId, staged.text);
        await invoke(IPC.MCP_CoordinatorNotificationAck, {
          coordinatorTaskId: taskId,
          batchId: staged.batchId,
        });
        clearStagedNotification(taskId);
        if (text().trim() === staged.text.trim()) setText('');
        setTaskPromptDraftActive(taskId, false);
        logWarn('autofire', 'auto-fire succeeded', { taskId });
      } catch (e) {
        logWarn('autofire', 'auto-fire failed', { taskId, err: String(e) });
        console.error('[coordinator] Auto-fire failed:', e);
      }
    })();
  }
  let autoFirePromptMissCount = 0;

  createEffect(() => {
    const notification = props.stagedNotification;

    if (autoFireInterval !== undefined) {
      clearInterval(autoFireInterval);
      autoFireInterval = undefined;
    }

    if (!notification) return;
    if (notification.userEdited) {
      logWarn('autofire', 'notification staged but userEdited=true — skipping', {
        taskId: props.taskId,
        batchId: notification.batchId,
      });
      return;
    }

    logWarn('autofire', 'notification staged — starting interval', {
      taskId: props.taskId,
      batchId: notification.batchId,
      autoFireAt: new Date(notification.autoFireAt).toISOString(),
      waitMs: notification.autoFireAt - Date.now(),
    });
    autoFirePromptMissCount = 0;
    let lastIntervalTail = '';

    // eslint-disable-next-line solid/reactivity -- intentional untracked reads in interval
    autoFireInterval = window.setInterval(() => {
      // Use untrack — we intentionally read current values on each tick
      // without subscribing to changes (the outer createEffect handles re-runs).
      const staged = untrack(() => props.stagedNotification);
      if (!staged || staged.userEdited) {
        logWarn('autofire', 'interval: notification gone or userEdited — cancelling', {
          taskId: props.taskId,
          gone: !staged,
          userEdited: staged?.userEdited,
        });
        clearInterval(autoFireInterval);
        autoFireInterval = undefined;
        return;
      }
      const currentTail = stripAnsi(untrack(() => getAgentOutputTail(props.agentId)));
      // If the agent produced new output since the last tick it is actively working
      // (e.g. mid-tool-call). Reset the miss counter so a long tool call doesn't
      // accumulate misses and trigger the escalation path prematurely.
      if (currentTail !== lastIntervalTail) {
        autoFirePromptMissCount = 0;
        lastIntervalTail = currentTail;
      }
      const tick = processAutoFireTick({
        staged,
        now: Date.now(),
        controlledBy: untrack(() => store.tasks[props.taskId]?.controlledBy),
        allowPromptlessGrace: props.coordinatorMode || props.controlledBy === 'coordinator',
        questionActive: untrack(() => questionActive()),
        promptDraftActive: hasUserPromptDraft(staged),
        terminalInputPending:
          untrack(() => store.tasks[props.taskId]?.terminalInputPending) === true,
        userActivityHoldUntil: untrack(() => store.tasks[props.taskId]?.userActivityHoldUntil),
        tail: currentTail,
        currentMissCount: autoFirePromptMissCount,
      });

      if (tick.outcome === 'too-soon') {
        debug('autofire', 'interval: waiting for autoFireAt', {
          taskId: props.taskId,
          remainingMs: staged.autoFireAt - Date.now(),
        });
        return;
      }
      if (tick.outcome === 'paused' || tick.outcome === 'waiting') {
        return;
      }
      if (tick.outcome === 'no-prompt') {
        autoFirePromptMissCount = tick.newMissCount;
        const tailSnippet = currentTail.slice(-PROMPT_MARKER_SCAN_CHARS);
        if (autoFirePromptMissCount === 1 || autoFirePromptMissCount % 5 === 0) {
          logWarn('autofire', 'prompt not detected after autoFireAt', {
            taskId: props.taskId,
            batchId: staged.batchId,
            missCount: autoFirePromptMissCount,
            hasPrompt: false,
            tailSnippet: tailSnippet.slice(-120).replace(/\n/g, '↵'),
          });
        }
        if (autoFirePromptMissCount >= 10) {
          const taskId = props.taskId;
          const missCount = autoFirePromptMissCount;
          logWarn('autofire', 'miss threshold reached — escalating to orphaned notification', {
            taskId,
            missCount,
          });
          clearInterval(autoFireInterval);
          autoFireInterval = undefined;
          clearStagedNotification(taskId);
          fireAndForget(IPC.MCP_CoordinatorNotificationDropAck, {
            coordinatorTaskId: taskId,
            batchId: staged.batchId,
          });
        }
        return;
      }
      // tick.outcome === 'fire'
      debug('autofire', 'interval: checking prompt marker', {
        taskId: props.taskId,
        batchId: staged.batchId,
        hasPrompt: true,
      });
      autoFirePromptMissCount = 0;
      logWarn('autofire', 'firing notification into coordinator PTY', { taskId: props.taskId });
      executeAutoFire(staged);
    }, 1_000);
  });

  onCleanup(() => {
    if (autoFireInterval !== undefined) {
      clearInterval(autoFireInterval);
      autoFireInterval = undefined;
    }
  });

  // When an internal activity lease returns to automation, immediately attempt
  // to fire any pending staged notification rather than waiting up to 1s.
  createEffect(
    on(
      // eslint-disable-next-line solid/reactivity
      [() => props.controlledBy, () => props.stagedNotification] as const,
      ([cb, staged], prev) => {
        const prevCb = prev?.[0];
        if (cb === 'coordinator' && prevCb === 'human' && staged && !staged.userEdited) {
          const tail = stripAnsi(untrack(() => getAgentOutputTail(props.agentId)));
          const tick = processAutoFireTick({
            staged,
            now: Date.now(),
            controlledBy: cb,
            allowPromptlessGrace: props.coordinatorMode || cb === 'coordinator',
            questionActive: untrack(() => questionActive()),
            promptDraftActive: hasUserPromptDraft(staged),
            terminalInputPending:
              untrack(() => store.tasks[props.taskId]?.terminalInputPending) === true,
            userActivityHoldUntil: untrack(() => store.tasks[props.taskId]?.userActivityHoldUntil),
            tail,
            currentMissCount: autoFirePromptMissCount,
          });
          if (tick.outcome === 'fire') {
            logWarn('autofire', 'immediate fire on control release', { taskId: props.taskId });
            executeAutoFire(staged);
          }
        }
      },
    ),
  );

  // --- Countdown display for auto-fire ---
  // Uses the parent-provided nowMs signal if available (avoids a duplicate interval).
  const autoFireCountdownText = () => {
    const notification = props.stagedNotification;
    if (!notification || notification.userEdited) return null;
    const now = props.nowMs ? props.nowMs() : Date.now();
    if (hasUserPromptDraft(notification)) return 'Queued — waiting for your draft';
    if (store.tasks[props.taskId]?.terminalInputPending) {
      return 'Queued — waiting for terminal input';
    }
    if ((store.tasks[props.taskId]?.userActivityHoldUntil ?? 0) > now) {
      return 'Queued — waiting for idle';
    }
    const remaining = Math.ceil((notification.autoFireAt - now) / 1_000);
    return remaining > 0 ? `Auto-sending in ${remaining}s…` : 'Sending when coordinator is ready…';
  };

  // When the agent shows a question/dialog, block automation so it does not
  // type into the TUI while leaving the user's current focus alone.
  const questionActive = () => isAgentAskingQuestion(props.agentId);
  const isRecentPromptEcho = (tail: string): boolean => {
    const task = store.tasks[props.taskId];
    const lastPrompt = task?.lastPrompt?.trim();
    if (!lastPrompt || !task?.lastInputAt) return false;
    const lastInputAt = Date.parse(task.lastInputAt);
    if (!Number.isFinite(lastInputAt)) return false;
    if (Date.now() - lastInputAt > PROMPT_ECHO_HANDOFF_SUPPRESS_MS) return false;
    const snippet = stripAnsi(lastPrompt).slice(0, 40);
    return Boolean(snippet && stripAnsi(tail).includes(snippet));
  };
  createEffect(
    on(
      // eslint-disable-next-line solid/reactivity
      [questionActive, () => props.controlledBy] as const,
      ([active, controlledBy], prev) => {
        const prevActive = prev?.[0] ?? false;
        // Trigger only when the question becomes newly active (false→true).
        // Do not restart the handoff when the internal activity lease changes while questionActive
        // is still true — activity lease changes can happen before the tail buffer
        // has cleared, which would immediately override the user's terminal answer.
        const questionJustActivated = active && !prevActive;
        const questionJustResolved = !active && prevActive;
        const tail = getAgentOutputTail(props.agentId);
        if (
          questionJustActivated &&
          shouldHandoffCoordinatorQuestion({
            controlledBy,
            questionActive: active,
            agentIdle: isAgentIdle(props.agentId),
            startupBlocking: isStartupBlockingAutoSend(tail),
            autoTrustSettling: isAutoTrustSettling(props.agentId),
            autoTrustHandled: isAgentTrustQuestionAutoHandled(props.agentId, tail),
            recentPromptEcho: isRecentPromptEcho(tail),
          })
        ) {
          markTaskUserActivity(props.taskId);
          setTaskTerminalInputPendingFromQuestion(props.taskId);
          setTaskTerminalInputPending(props.taskId, true);
          showNotification('Agent needs input. Answer in the terminal when ready.');
        }
        if (questionJustResolved) {
          // Only clear if pending was set by the question handoff and not since
          // overridden by actual terminal typing (which clears the question flag).
          if (store.tasks[props.taskId]?.terminalInputPendingFromQuestion) {
            setTaskTerminalInputPending(props.taskId, false);
          }
        }
      },
    ),
  );
  createEffect(() => {
    const task = store.tasks[props.taskId];
    if (!task?.coordinatedBy || task.controlledBy !== 'human') return;
    if (task.promptDraftActive || task.terminalInputPending || questionActive()) return;
    if ((task.userActivityHoldUntil ?? 0) > Date.now()) return;
    setTaskControl(props.taskId, 'coordinator');
  });

  let textareaRef: HTMLTextAreaElement | undefined;

  function hasUserPromptDraft(staged = props.stagedNotification): boolean {
    return hasUserPromptDraftText(text(), staged?.text);
  }

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

  let sendAbortController: AbortController | undefined;

  async function handleSend(mode: 'manual' | 'auto' = 'manual') {
    if (sending()) return;
    if (isLandedTaskState(store.tasks[props.taskId]?.landingState)) return;
    // Block sends while the agent is showing a question/dialog.
    // For auto-sends, use a fresh tail-buffer check instead of the reactive
    // signal — the signal may be stale (updated by throttled analysis) while
    // the callers (onReady, quiescence timer) already verified with fresh data.
    if (mode === 'auto') {
      const tail = getAgentOutputTail(props.agentId);
      if (isStartupBlockingAutoSend(tail)) {
        return;
      }
      if (isQuestionBlockingAutoSend(props.agentId, tail)) {
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
      markTaskUserActivity(props.taskId);
      return;
    }
    if (mode === 'manual') markTaskUserActivity(props.taskId);

    sendAbortController?.abort();
    sendAbortController = new AbortController();
    const { signal } = sendAbortController;

    setSending(true);
    try {
      const initialPromptSnapshot = props.initialPrompt?.trim();
      const shouldAckInitialPrompt = shouldAckInitialPromptDelivery({
        coordinatedBy: props.coordinatedBy,
        initialPrompt: initialPromptSnapshot,
        sentText: val,
      });
      // Snapshot tail before send for verification comparison.
      const preSendTail = getAgentOutputTail(props.agentId);
      await sendPrompt(props.taskId, props.agentId, val);

      if (mode === 'auto') {
        // Wait for the prompt to appear in output before marking it delivered.
        const appeared = await pollUntilPromptAppearsInOutput(
          props.agentId,
          val,
          preSendTail,
          signal,
          getAgentOutputTail,
          PROMPT_VERIFY_TIMEOUT_MS,
          PROMPT_VERIFY_POLL_MS,
        );
        const outcome = resolveAutoSendVerifyOutcome({
          appeared,
          aborted: signal.aborted,
          retryCount: untrack(autoSendRetry),
          maxRetries: AUTO_SEND_MAX_RETRIES,
        });
        if (outcome !== 'deliver') {
          // The echo was never confirmed — Codex likely received the prompt
          // during a mid-startup redraw and discarded it.  `sendPrompt` already
          // cleared the queued `initialPrompt`, so on a retry we restore it and
          // bump the retry counter in one batch: restoring re-arms this
          // createEffect (which keys off props.initialPrompt) and restores the
          // "Waiting to send prompt…" status; batching the two tracked writes
          // re-runs the effect exactly once.  On giveup we clear it for good so
          // a stray effect re-run can't fire again.  Either way the text stays
          // in the field so the user can send manually.  An aborted send was
          // superseded — leave all state untouched.
          if (outcome === 'retry') {
            batch(() => {
              if (initialPromptSnapshot) setInitialPrompt(props.taskId, initialPromptSnapshot);
              setAutoSendRetry((n) => n + 1);
            });
          } else if (outcome === 'giveup') {
            clearInitialPrompt(props.taskId);
          }
          return;
        }
      }

      if (signal.aborted) return;

      setTaskPromptDraftActive(props.taskId, false);
      if (initialPromptSnapshot && val === initialPromptSnapshot) {
        setAutoSentInitialPrompt(initialPromptSnapshot);
      }
      if (shouldAckInitialPrompt) {
        invoke(IPC.MCP_CoordinatedTaskPromptDelivered, { taskId: props.taskId }).catch(() => {});
      }
      // If the user manually sent the staged notification text exactly, ack it
      const staged = props.stagedNotification;
      if (staged && !staged.userEdited && val === staged.text) {
        const ackTaskId = props.taskId;
        invoke(IPC.MCP_CoordinatorNotificationAck, {
          coordinatorTaskId: ackTaskId,
          batchId: staged.batchId,
        })
          .then(() => clearStagedNotification(ackTaskId))
          .catch(() => {});
      } else if (staged && staged.notificationIds.length > 0) {
        // User sent their own message while a coordinator notification was pending.
        // Clear locally so stale staged text can't re-fire on the next autofire tick,
        // then reschedule the re-stage timer so notifications reappear after the delay.
        clearStagedNotification(props.taskId);
        invoke(IPC.MCP_CoordinatorRestageAfterUserSend, {
          coordinatorTaskId: props.taskId,
        }).catch(() => {});
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
      data-panel-focused={isPanelFocused(props.taskId, 'prompt') ? 'true' : 'false'}
      style={{
        display: 'flex',
        height: '100%',
        padding: '4px 6px',
        'border-radius': 'var(--radius-lg)',
      }}
    >
      <div style={{ position: 'relative', flex: '1', display: 'flex' }}>
        <Show when={!!props.stagedNotification && !props.stagedNotification.userEdited}>
          <div
            style={{
              position: 'absolute',
              top: '4px',
              left: '8px',
              'font-size': '11px',
              color: theme.accent,
              background: `${theme.accent}22`,
              padding: '1px 6px',
              'border-radius': 'var(--radius-xs)',
              'pointer-events': 'none',
              'z-index': '1',
            }}
          >
            Staged for auto-send
          </div>
        </Show>
        <textarea
          class="prompt-textarea"
          ref={(el) => {
            textareaRef = el;
            props.ref?.(el);
          }}
          rows={3}
          value={text()}
          // Intentionally NOT disabled while a question is active: typing is
          // harmless (nothing leaves the box until handleSend, which still
          // guards on questionActive()).  Hard-disabling here could latch the
          // box permanently uneditable if question-detection ever sticks true —
          // the dimmed style + placeholder below still signal "answer in
          // terminal", and the send button/Enter remain blocked.
          onInput={(e) => {
            const val = e.currentTarget.value;
            setText(val);
            markTaskUserActivity(props.taskId);
            setTaskPromptDraftActive(props.taskId, hasUserPromptDraft());
          }}
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
            border:
              props.stagedNotification && !props.stagedNotification.userEdited
                ? `1px solid ${theme.accent}60`
                : `1px solid ${theme.border}`,
            'border-radius': 'var(--radius-lg)',
            padding:
              props.stagedNotification && !props.stagedNotification.userEdited
                ? '20px 36px 6px 10px'
                : '6px 36px 6px 10px',
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
        <Show
          when={
            !!props.stagedNotification?.userEdited &&
            (props.stagedNotification?.hiddenCompletionCount ?? 0) > 0
          }
        >
          <div
            style={{
              position: 'absolute',
              bottom: '40px',
              right: '6px',
              'font-size': '11px',
              color: theme.fgSubtle,
              background: theme.bgHover,
              padding: '2px 6px',
              'border-radius': 'var(--radius-xs)',
            }}
          >
            + {props.stagedNotification?.hiddenCompletionCount} more task(s) completed
          </div>
        </Show>
      </div>
      <Show when={autoFireCountdownText() !== null}>
        <div
          style={{
            'font-size': '11px',
            color: theme.fgSubtle,
            padding: '2px 4px',
            'margin-top': '2px',
          }}
        >
          {autoFireCountdownText()}
        </div>
      </Show>
    </div>
  );
}
