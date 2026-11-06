/** PR babysitting: sends a task's failing PR checks and merge conflicts to its
 *  agent until CI passes.
 *  One toggle per task covers all its PRs, since they share the task's agent. */
import { reconcile } from 'solid-js/store';
import { errMessage, warn as logWarn } from '../lib/log';
import { buildMergeConflictPrompt } from '../lib/github-prompts';
import { parseGitHubUrl } from '../lib/github-url';
import {
  MAX_BABYSIT_ATTEMPTS,
  babysitCiWaitReason,
  combinedBabysitChecks,
  isAwaitingFixPush,
  nextBabysitStep,
  type BabysitChecks,
  type PrBabysit,
} from '../lib/pr-babysit';
import { setStore, store } from './core';
import { composerInputBlocker } from './delegation';
import { getPullRequestDetails, loadFailedChecksPrompt } from './github';
import { isLandedTaskState } from './landing';
import { showNotification } from './notification';
import { saveState } from './persistence';
import { getPrChecks } from './pr-checks-state';
import { taskPrsKnown } from './pr-checks';
import { taskPrs, taskPrsChecks } from './task-prs';
import { isAgentAskingQuestion, isAgentIdle } from './taskStatus';
import { sendPrompt } from './tasks';

// shortcut: polling store reads is cheap and CI moves in minutes; an effect
// plus timers for typing holds would only matter if latency did.
const BABYSIT_TICK_MS = 5_000;
// An agent starts a turn within a second or two of Enter; fixing CI takes far longer.
const START_CHECK_MS = 10_000;
// An agent's push usually shows within one 30s PR-checks tick, and any push by
// the 5-minute settled refresh; idle past that with no push means it stopped,
// often on a command it could not run.
const STALL_MS = 6 * 60_000;
const STALLED_STATUS = 'Stuck: checks still fail and no fix was pushed';

export function getPrBabysit(taskId: string): PrBabysit | undefined {
  return store.tasks[taskId]?.prBabysit;
}

/** All of the task's PRs as the one state babysitting follows. */
function babysitChecks(taskId: string): BabysitChecks | undefined {
  const task = store.tasks[taskId];
  if (!task) return undefined;
  const checks = combinedBabysitChecks(taskPrsChecks(task));
  // A merge only ends Babysit once no other PR of the task can still be open.
  return checks?.merged && !taskPrsKnown(task) ? undefined : checks;
}

/** Whether the task has an open PR for Babysit to watch. */
export function hasOpenTaskPr(taskId: string): boolean {
  const task = store.tasks[taskId];
  return !!task && taskPrsChecks(task).some((checks) => checks !== undefined && !checks.merged);
}

// PRs confirmed as the user's while Babysit is on, by task: a PR's author
// never changes, so a later gh hiccup cannot stop Babysit, and each PR costs
// one lookup. Turning Babysit on checks afresh.
const confirmedPrsByTask = new Map<string, Set<string>>();

/** Why the PR's CI logs must not go to the agent unreviewed; null when they may. */
async function babysitRefusal(taskId: string, prUrl: string): Promise<string | null> {
  if (confirmedPrsByTask.get(taskId)?.has(prUrl)) return null;
  const details = await getPullRequestDetails(prUrl);
  if (details.authoredByViewer === true) {
    const confirmed = confirmedPrsByTask.get(taskId) ?? new Set<string>();
    confirmedPrsByTask.set(taskId, confirmed.add(prUrl));
    return null;
  }
  return details.authoredByViewer === false
    ? 'Babysit is only available for pull requests you opened.'
    : 'Could not confirm you opened this pull request. Is gh signed in?';
}

/**
 * Turns babysitting on for the task's open PRs. Only PRs the signed-in GitHub
 * user opened qualify: their CI logs come from the user's own code, which is
 * what makes sending them unreviewed acceptable. PRs found later are checked
 * before their failures are sent. Returns whether it was turned on.
 */
export async function startPrBabysit(taskId: string): Promise<boolean> {
  const task = store.tasks[taskId];
  const urls = task
    ? taskPrs(task)
        .filter((pr) => getPrChecks(pr.watchId)?.merged !== true)
        .map((pr) => pr.url)
    : [];
  if (urls.length === 0) return false;
  confirmedPrsByTask.delete(taskId);
  const refusals = await Promise.all(urls.map((url) => babysitRefusal(taskId, url)));
  const refusal = refusals.find((r) => r !== null);
  if (refusal) {
    showNotification(refusal);
    return false;
  }
  if (!store.tasks[taskId]) return false;
  setPrBabysit(taskId, { attempts: 0 });
  return true;
}

export function stopPrBabysit(taskId: string): void {
  confirmedPrsByTask.delete(taskId);
  if (getPrBabysit(taskId)) setPrBabysit(taskId, undefined);
}

function setPrBabysit(taskId: string, next: PrBabysit | undefined): void {
  // Replace rather than merge, so a reset drops `lastSentSha` and `stalled`
  // cleanly; a plain object would be merged into the stored one.
  setStore('tasks', taskId, 'prBabysit', next === undefined ? undefined : reconcile({ ...next }));
  void saveState();
}

/**
 * True when babysitting cannot move on by itself, so the failing PR is the
 * user's: it stalled, or its agent exited. A crash already reads as a failure;
 * a clean exit would otherwise leave the task waiting on nobody.
 */
export function isPrBabysitStuck(taskId: string): boolean {
  const task = store.tasks[taskId];
  if (!task?.prBabysit) return false;
  if (task.prBabysit.stalled) return true;
  const agentId = task.agentIds[0];
  // Closing stops the agents on purpose.
  return !task.closingStatus && !!agentId && store.agents[agentId]?.status === 'exited';
}

/** Why the task's first agent cannot take an automatic prompt now; null when it can. */
export function babysitAgentBlocker(taskId: string): string | null {
  const task = store.tasks[taskId];
  const agentId = task?.agentIds[0];
  const agent = agentId ? store.agents[agentId] : undefined;
  if (!task || !agentId || agent?.status !== 'running') return 'The agent is not running';
  // A paused task holds all automatic input, babysit included.
  if (task.delegationPaused) return 'The task is paused';
  if (task.closingStatus === 'closing' || task.closingStatus === 'removing')
    return 'The task is closing';
  if (isLandedTaskState(task.landingState)) return 'The task has landed';
  if (!isAgentIdle(agentId)) return 'The agent is busy';
  if (isAgentAskingQuestion(agentId)) return 'The agent seems to be waiting for an answer';
  return composerInputBlocker(task, true);
}

/** The task's first agent when it can take an automatic prompt now. */
function readyAgentId(taskId: string): string | null {
  return babysitAgentBlocker(taskId) === null ? (store.tasks[taskId]?.agentIds[0] ?? null) : null;
}

/** What babysitting is waiting for, shown on its toggle; null when it is off. */
export function prBabysitStatus(taskId: string): string | null {
  const babysit = getPrBabysit(taskId);
  if (!babysit) return null;
  if (babysit.stalled) return STALLED_STATUS;
  const ciReason = babysitCiWaitReason(babysit, babysitChecks(taskId));
  if (ciReason) return ciReason;
  const blocker = babysitAgentBlocker(taskId);
  return blocker
    ? `Checks failed; waiting: ${blocker}`
    : 'Sending CI failures and conflicts to the agent';
}

/** The failure prompts of the task's failing PRs, or why they must not be sent;
 *  an empty list when none has a failing check to send. A PR whose failing head
 *  is in `sentHeads` was sent already, so the agent is not told twice. */
async function loadFailurePrompts(
  taskId: string,
  sentHeads: ReadonlySet<string>,
): Promise<string[] | { refusal: string }> {
  const task = store.tasks[taskId];
  const failing = task
    ? taskPrs(task).filter((pr) => {
        const checks = getPrChecks(pr.watchId);
        if (checks?.overall !== 'failure' || checks.merged) return false;
        return !checks.headSha || !sentHeads.has(checks.headSha);
      })
    : [];
  const prompts: string[] = [];
  for (const pr of failing) {
    const number = parseGitHubUrl(pr.url)?.number;
    if (!number) continue;
    // Confirmed already unless found after Babysit was turned on.
    const refusal = await babysitRefusal(taskId, pr.url);
    if (refusal) return { refusal };
    const ref = { number: Number(number), url: pr.url, ...(pr.repo ? { repo: pr.repo } : {}) };
    // The conflict is the watcher's own check, so GitHub's failed checks never list it.
    if (getPrChecks(pr.watchId)?.mergeable === 'CONFLICTING')
      prompts.push(buildMergeConflictPrompt(ref));
    const prompt = await loadFailedChecksPrompt(ref);
    if (prompt !== null) prompts.push(prompt);
  }
  return prompts;
}

async function deliverFailures(taskId: string, headSha: string): Promise<void> {
  const lastSent = store.tasks[taskId]?.prBabysit?.lastSentSha;
  const sentHeads = new Set(lastSent ? lastSent.split(',') : []);
  const prompts = await loadFailurePrompts(taskId, sentHeads);
  // Collecting logs takes seconds; anything may have changed meanwhile.
  const babysit = store.tasks[taskId]?.prBabysit;
  if (!babysit || babysitChecks(taskId)?.headSha !== headSha) return;
  if (!Array.isArray(prompts)) {
    stopPrBabysit(taskId);
    showNotification(`Babysit stopped: ${prompts.refusal}`);
    return;
  }
  if (prompts.length === 0 && headSha.split(',').some((head) => sentHeads.has(head))) {
    // The agent still works on failures it was sent; the stall watch covers it.
    setPrBabysit(taskId, { ...babysit, lastSentSha: headSha });
    return;
  }
  if (prompts.length === 0) {
    // Nothing the agent can act on, such as a check without logs; skip this commit.
    setPrBabysit(taskId, { ...babysit, lastSentSha: headSha, stalled: true });
    showNotification(
      'Babysit could not load a failing check to send. It is back with you until the next push.',
    );
    return;
  }
  const prompt = prompts.join('\n\n');
  const agentId = readyAgentId(taskId);
  if (!agentId) return;
  const attempts = babysit.attempts + 1;
  // Recorded first so a slow send cannot overlap a second one for the same commit.
  setPrBabysit(taskId, { attempts, lastSentSha: headSha });
  await sendPrompt(taskId, agentId, prompt, { appPrompt: true });
  showNotification(
    `Babysit sent CI failures or conflicts to the agent (${attempts}/${MAX_BABYSIT_ATTEMPTS}).`,
  );
  // A paste the agent holds instead of submitting would otherwise fail silently.
  // shortcut: one late look — a turn that ends inside the window is a false alarm.
  await new Promise((r) => setTimeout(r, START_CHECK_MS));
  if (store.agents[agentId]?.status === 'running' && isAgentIdle(agentId)) {
    const name = store.tasks[taskId]?.name ?? 'the task';
    showNotification(
      `Babysit pasted CI failures or conflicts into “${name}”, but the agent did not start. Check its terminal; it may need Enter.`,
    );
  }
}

/**
 * Flags a babysat task whose agent sat idle past STALL_MS while CI kept
 * failing on the commit it was sent, and clears the flag once a push arrives.
 * `idleSince` is the watcher's per-task memory of when the idle spell began.
 */
function trackStall(taskId: string, babysit: PrBabysit, idleSince: Map<string, number>): void {
  const clearStall = (): void => {
    const { attempts, lastSentSha } = babysit;
    setPrBabysit(taskId, lastSentSha ? { attempts, lastSentSha } : { attempts });
  };
  if (!isAwaitingFixPush(babysit, babysitChecks(taskId))) {
    idleSince.delete(taskId);
    if (babysit.stalled) clearStall();
    return;
  }
  if (babysit.stalled) {
    // Nudged back to work, the agent gets a fresh STALL_MS to push its fix.
    const agentId = store.tasks[taskId]?.agentIds[0];
    if (agentId && store.agents[agentId]?.status === 'running' && !isAgentIdle(agentId))
      clearStall();
    return;
  }
  // Only a ready agent counts: a question or a paused task already says why it waits.
  if (babysitAgentBlocker(taskId) !== null) {
    idleSince.delete(taskId);
    return;
  }
  const since = idleSince.get(taskId) ?? Date.now();
  idleSince.set(taskId, since);
  if (Date.now() - since < STALL_MS) return;
  idleSince.delete(taskId);
  setPrBabysit(taskId, { ...babysit, stalled: true });
  const name = store.tasks[taskId]?.name ?? 'the task';
  showNotification(
    `Babysit is stuck on “${name}”: the agent stopped and no fix was pushed. It may have hit a command it could not run.`,
  );
}

/** Watches babysat tasks; returns a stop function. */
export function startPrBabysitWatcher(): () => void {
  const inFlight = new Set<string>();
  const idleSince = new Map<string, number>();

  const tick = (): void => {
    for (const [taskId, task] of Object.entries(store.tasks)) {
      const babysit = task?.prBabysit;
      if (!babysit || inFlight.has(taskId)) continue;
      // Its last PR closed unmerged: no toggle shows any more to turn Babysit off.
      if (taskPrs(task).length === 0 && taskPrsKnown(task)) {
        stopPrBabysit(taskId);
        continue;
      }
      const step = nextBabysitStep(babysit, babysitChecks(taskId));
      trackStall(taskId, babysit, idleSince);
      if (step.kind === 'done') stopPrBabysit(taskId);
      else if (step.kind === 'reset') setPrBabysit(taskId, { attempts: 0 });
      else if (step.kind === 'give-up') {
        stopPrBabysit(taskId);
        showNotification(
          `Babysit stopped: checks still fail after ${MAX_BABYSIT_ATTEMPTS} fix attempts.`,
        );
      } else if (step.kind === 'send' && readyAgentId(taskId)) {
        inFlight.add(taskId);
        deliverFailures(taskId, step.headSha)
          .catch((err: unknown) => {
            // Retrying every tick would hammer GitHub, so stop and tell the user.
            stopPrBabysit(taskId);
            logWarn('pr-babysit', 'Sending CI failures failed', { err: errMessage(err) });
            showNotification(`Babysit stopped: ${errMessage(err)}`);
          })
          .finally(() => inFlight.delete(taskId));
      }
    }
  };

  const timer = window.setInterval(tick, BABYSIT_TICK_MS);
  tick();
  return () => clearInterval(timer);
}
