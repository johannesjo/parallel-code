// Integrating a child's branch into its target: land_self (the child merges
// itself after passing verification) and merge_task (the coordinator merges
// it). Both rebase onto the target, run the project's verify command, merge,
// and record the landing state the renderer shows.

import { getMainBranch, mergeTask as gitMergeTask, rebaseTask } from '../../ipc/git.js';
import { buildVerifyEnv, verificationRunner } from '../../ipc/verify.js';
import { pendingVerificationRun } from '../../shared/verification-run.js';
import type { VerificationRun } from '../../ipc/shared-types.js';
import { IPC } from '../../ipc/channels.js';
import {
  detectPreambleFiles,
  buildNormalizedPreambleFileDiff,
  stripPreambleFromBranch,
} from '../preamble.js';
import {
  execAsync,
  execStdout,
  containsBranch,
  currentBranch,
  statusPaths,
  PREAMBLE_ARTIFACT_PATHS,
} from './git.js';
import type { CoordinatorNotifications } from './notifications.js';
import type {
  ApiLandSelfResult,
  CoordinatedTask,
  CoordinatorState,
  LandSelfInput,
  LandingState,
  SubtaskVerification,
} from '../types.js';

/** Lines a merge changed, sent with MCP_TaskClosed when a task leaves by merging. */
export interface MergedLines {
  linesAdded: number;
  linesRemoved: number;
}

/** What landing reads from, and asks of, the coordinator that owns it. */
export interface LandingHost {
  readonly tasks: ReadonlyMap<string, CoordinatedTask>;
  readonly coordinators: ReadonlyMap<string, CoordinatorState>;
  readonly notifications: CoordinatorNotifications;
  /** Throws once orchestration is disabled or the operation's epoch was canceled. */
  assertOrchestrationEnabled(epoch?: number): void;
  /** Tear down a self-landed child: notify, stop its agent, delete its worktree. */
  cleanupLandedTaskResources(task: CoordinatedTask, merged: MergedLines): Promise<void>;
  /** Close a child after merge_task's cleanup option. */
  cleanupTask(taskId: string, merged?: MergedLines): Promise<void>;
  notifyRenderer(channel: string, data: unknown): void;
}

const GIT_LOCK_RETRY_DELAY_MS = 2_000;
/** Rebase-and-verify rounds before a base that other landings keep moving escalates. */
const LANDING_VERIFY_ATTEMPTS = 3;
const UNRESOLVED_LANDED_COMMIT = 'unresolved';

function isPassedVerification(verification: SubtaskVerification | undefined): boolean {
  return Boolean(
    verification?.checks.length && verification.checks.every((check) => check.result === 'passed'),
  );
}

const VERIFY_ESCALATION_TAIL_LINES = 40;

/** Reason shown to the agent and the user; carries enough output to act on. */
function describeVerificationFailure(run: VerificationRun): string {
  const tail = run.outputTail.trim().split('\n').slice(-VERIFY_ESCALATION_TAIL_LINES).join('\n');
  const head =
    run.status === 'failed'
      ? `Verification failed (exit ${run.exitCode ?? '?'}): \`${run.command}\``
      : `Verification ${run.status.replace('_', ' ')}: \`${run.command}\`${run.message ? ` — ${run.message}` : ''}`;
  return tail ? `${head}\n${tail}` : head;
}

function verificationFailureReason(verification: SubtaskVerification | undefined): string {
  if (!verification?.checks.length) return 'land_self requires at least one verification check';
  const failed = verification.checks.find((check) => check.result !== 'passed');
  if (!failed) return 'verification passed';
  return `verification ${failed.result}: ${failed.name}${failed.reason ? ` — ${failed.reason}` : ''}`;
}

export class CoordinatorLanding {
  private landedOrderCounters = new Map<string, number>();

  constructor(private readonly host: LandingHost) {}

  /** A restored landed child keeps its place: later landings order after it. */
  seedLandedOrder(coordinatorTaskId: string, landedOrder: number): void {
    const current = this.landedOrderCounters.get(coordinatorTaskId) ?? 0;
    this.landedOrderCounters.set(coordinatorTaskId, Math.max(current, landedOrder));
  }

  forgetCoordinator(coordinatorTaskId: string): void {
    this.landedOrderCounters.delete(coordinatorTaskId);
  }

  private nextLandedOrder(coordinatorTaskId: string): number {
    const next = (this.landedOrderCounters.get(coordinatorTaskId) ?? 0) + 1;
    this.landedOrderCounters.set(coordinatorTaskId, next);
    return next;
  }

  private syncLandingState(task: CoordinatedTask): void {
    // Detach renderer MCP state only after a successful merge (landed states);
    // escalation/failure states leave it attached so the task stays reachable.
    const detachMcpState =
      task.landingState === 'landed_pending_review' ||
      task.landingState === 'landed_cleanup_failed';
    this.host.notifyRenderer(IPC.MCP_TaskStateSync, {
      taskId: task.id,
      verification: task.verification,
      verificationRun: task.verificationRun,
      landingState: task.landingState,
      landingReason: task.landingReason ?? null,
      landingSummary: task.landingSummary ?? null,
      landedMetadata: task.landedMetadata ?? null,
      needsReview:
        task.landingState === 'landed_pending_review' ||
        task.landingState === 'landed_cleanup_failed' ||
        task.landingState === 'landing_escalated' ||
        task.landingState === 'landing_failed',
      controlledBy: detachMcpState ? null : undefined,
      mcpConfigPath: detachMcpState ? null : undefined,
      mcpStartupStatus: detachMcpState ? null : undefined,
    });
  }

  private escalateLanding(task: CoordinatedTask, state: LandingState, reason: string): void {
    task.landingState = state;
    task.landingReason = reason;
    this.syncLandingState(task);
  }

  /** Runs the project's verify command in the task worktree, the same check the
   *  Finish dialog offers. Anything but a pass escalates so the user sees the
   *  task flagged, and throws so the calling agent sees the output.
   *  `assertAllowed` throws once the landing is canceled; each retry checks it first. */
  private async verifyBeforeLanding(
    task: CoordinatedTask,
    assertAllowed: () => void,
  ): Promise<void> {
    const command = this.host.coordinators.get(task.coordinatorTaskId)?.verifyCommand;
    const worktreePath = task.worktreePath;
    if (!command || !worktreePath) return;
    // The merge replays the task onto its base, so a pass on the branch alone
    // says nothing about what lands. Verify the rebased branch instead; the
    // merge's own rebase is then a no-op and fast-forwards to the checked HEAD.
    // shortcut: a landing between the last check and the merge goes unverified —
    // pass the checked base into gitMergeTask if that window ever matters.
    const baseBranch = task.baseBranch ?? (await getMainBranch(task.projectRoot));
    for (let attempt = 1; attempt <= LANDING_VERIFY_ATTEMPTS; attempt++) {
      assertAllowed();
      await this.escalateOnError(task, () => rebaseTask(worktreePath, baseBranch));
      await this.runLandingVerification(task, worktreePath, command);
      const settled = await this.escalateOnError(task, () =>
        containsBranch(worktreePath, baseBranch),
      );
      if (settled) return;
    }
    const reason = `${baseBranch} kept moving while \`${command}\` ran; land again once it settles.`;
    this.escalateLanding(task, 'landing_escalated', reason);
    throw new Error(reason);
  }

  private async escalateOnError<T>(task: CoordinatedTask, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      this.escalateLanding(
        task,
        'landing_escalated',
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }

  private async runLandingVerification(
    task: CoordinatedTask,
    worktreePath: string,
    command: string,
  ): Promise<void> {
    const pending = pendingVerificationRun(command);
    this.syncVerificationRun(task, pending);
    const run = await verificationRunner
      .start({
        key: task.id,
        worktreePath,
        command,
        env: buildVerifyEnv({ taskId: task.id, branchName: task.branchName, worktreePath }),
      })
      // A rejected start means the runner could not even spawn. Report it as an
      // error run so it escalates like any failure instead of leaving the task
      // stuck at "running".
      .catch(
        (err: unknown): VerificationRun => ({
          ...pending,
          status: 'error',
          finishedAt: new Date().toISOString(),
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    this.syncVerificationRun(task, run);
    if (run.status === 'passed') return;
    const reason = describeVerificationFailure(run);
    this.escalateLanding(task, 'landing_escalated', reason);
    throw new Error(reason);
  }

  private syncVerificationRun(task: CoordinatedTask, run: VerificationRun): void {
    task.verificationRun = run;
    this.host.notifyRenderer(IPC.MCP_TaskStateSync, { taskId: task.id, verificationRun: run });
  }

  private async prepareCleanSelfLandingWorktree(
    task: CoordinatedTask,
    assertAllowed: () => void,
  ): Promise<void> {
    const actualBranch = await currentBranch(task.worktreePath);
    if (actualBranch === null) {
      throw new Error(
        `The worktree for '${task.branchName}' has a detached HEAD. Check out '${task.branchName}' before landing.`,
      );
    }
    if (actualBranch !== task.branchName) {
      throw new Error(
        `Branch mismatch: the worktree is on '${actualBranch}' but the task expects '${task.branchName}'.`,
      );
    }

    const preambleFiles = await detectPreambleFiles(task.worktreePath);
    const dirtyPathsBeforeStrip = await statusPaths(task.worktreePath);
    const dirtyPreamblePaths = dirtyPathsBeforeStrip.filter(
      (pathName) => preambleFiles.has(pathName) && PREAMBLE_ARTIFACT_PATHS.has(pathName),
    );
    const dirtyPreambleUserPaths: string[] = [];
    for (const pathName of dirtyPreamblePaths) {
      const normalizedDiff = await buildNormalizedPreambleFileDiff(
        pathName,
        task.worktreePath,
        'HEAD',
      );
      if (normalizedDiff.trim()) dirtyPreambleUserPaths.push(pathName);
    }
    if (dirtyPreambleUserPaths.length > 0) {
      throw new Error(
        `Task worktree has uncommitted changes in preamble files: ${dirtyPreambleUserPaths.join(', ')}. Commit or discard them before calling land_self.`,
      );
    }

    await stripPreambleFromBranch(task);

    const dirtyPaths = await statusPaths(task.worktreePath);
    const nonPreamblePaths = dirtyPaths.filter(
      (pathName) => !preambleFiles.has(pathName) || !PREAMBLE_ARTIFACT_PATHS.has(pathName),
    );
    if (nonPreamblePaths.length > 0) {
      throw new Error(
        `Task worktree has uncommitted changes: ${nonPreamblePaths.join(', ')}. Commit or discard them before calling land_self.`,
      );
    }

    if (dirtyPaths.length > 0) {
      // nonPreamblePaths check above guarantees every path here is a preamble artifact.
      const unexpectedPaths = dirtyPaths.filter(
        (p) => !preambleFiles.has(p) || !PREAMBLE_ARTIFACT_PATHS.has(p),
      );
      if (unexpectedPaths.length > 0) {
        throw new Error(
          `Unexpected non-preamble paths staged before cleanup commit: ${unexpectedPaths.join(', ')}`,
        );
      }
      assertAllowed();
      await execAsync('git', ['add', '-A', '--', ...dirtyPaths], { cwd: task.worktreePath });
      try {
        assertAllowed();
        await execAsync('git', ['commit', '-m', 'Remove Parallel Code sub-task preamble'], {
          cwd: task.worktreePath,
        });
      } catch {
        /* no staged preamble cleanup */
      }
    }

    const remainingDirtyPaths = await statusPaths(task.worktreePath);
    if (remainingDirtyPaths.length > 0) {
      throw new Error(
        `Task worktree is still dirty after injected artifacts were handled: ${remainingDirtyPaths.join(', ')}`,
      );
    }
  }

  /**
   * The coordinator worktree holds the target branch only for children based on
   * it; every other target merges in the project root, like a normal Finish.
   */
  private integrationWorktree(task: CoordinatedTask): string | undefined {
    const parent = this.host.coordinators.get(task.coordinatorTaskId);
    return parent?.worktreePath && parent.branchName === task.baseBranch
      ? parent.worktreePath
      : undefined;
  }

  private async runGitMerge(
    task: CoordinatedTask,
    opts?: { squash?: boolean; message?: string },
    assertAllowed?: () => void,
  ): Promise<{ mainBranch: string; linesAdded: number; linesRemoved: number }> {
    const runMerge = () => {
      assertAllowed?.();
      return gitMergeTask(
        task.projectRoot,
        task.branchName,
        opts?.squash ?? false,
        opts?.message ?? null,
        false,
        task.baseBranch,
        task.worktreePath,
        this.integrationWorktree(task),
      );
    };
    let result: Awaited<ReturnType<typeof runMerge>>;
    try {
      result = await runMerge();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Another git process') || msg.includes('index.lock')) {
        await new Promise((r) => setTimeout(r, GIT_LOCK_RETRY_DELAY_MS));
        result = await runMerge();
      } else {
        throw err;
      }
    }

    return {
      mainBranch: result.main_branch,
      linesAdded: result.lines_added,
      linesRemoved: result.lines_removed,
    };
  }

  private async resolveLandedCommit(task: CoordinatedTask, targetBranch: string): Promise<string> {
    const integrationWorktree = this.integrationWorktree(task);
    const attempts: Array<{ cwd: string; rev: string }> = [];
    if (integrationWorktree) {
      attempts.push({ cwd: integrationWorktree, rev: 'HEAD' });
    }
    attempts.push({ cwd: task.projectRoot, rev: targetBranch });

    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        const result = await execAsync('git', ['rev-parse', attempt.rev], { cwd: attempt.cwd });
        return execStdout(result).trim();
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async landSelfUnchecked(
    taskId: string,
    input: LandSelfInput,
    epoch: number,
  ): Promise<ApiLandSelfResult> {
    const task = this.host.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    if (task.integrationPolicy === 'review')
      throw new Error('This result requires user review and approval before integration.');

    if (!this.host.coordinators.has(task.coordinatorTaskId)) {
      const reason = `Cannot self-land orphaned task: coordinator ${task.coordinatorTaskId} is not registered`;
      this.escalateLanding(task, 'landing_escalated', reason);
      throw new Error(reason);
    }

    if (!isPassedVerification(input.verification)) {
      const reason = verificationFailureReason(input.verification);
      this.escalateLanding(task, 'landing_escalated', reason);
      throw new Error(reason);
    }

    // Only persist verification/summary after all validation passes so rejected
    // calls don't leave bogus data visible in the renderer.
    task.verification = input.verification;
    task.landingSummary = input.summary;

    try {
      await this.prepareCleanSelfLandingWorktree(task, () =>
        this.host.assertOrchestrationEnabled(epoch),
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.escalateLanding(task, 'landing_escalated', reason);
      throw err;
    }
    await this.verifyBeforeLanding(task, () => this.host.assertOrchestrationEnabled(epoch));

    let mergeResult: { mainBranch: string; linesAdded: number; linesRemoved: number };
    try {
      mergeResult = await this.runGitMerge(task, { squash: false }, () =>
        this.host.assertOrchestrationEnabled(epoch),
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const state =
        reason.toLowerCase().includes('conflict') || reason.includes('Merge failed')
          ? 'landing_escalated'
          : 'landing_failed';
      this.escalateLanding(task, state, reason);
      throw err;
    }

    let landedCommit: string;
    try {
      landedCommit = await this.resolveLandedCommit(task, mergeResult.mainBranch);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const metadata = {
        taskId: task.id,
        taskName: task.name,
        coordinatorTaskId: task.coordinatorTaskId,
        targetBranch: mergeResult.mainBranch,
        landedCommit: UNRESOLVED_LANDED_COMMIT,
        landedAt: new Date().toISOString(),
        landedOrder: this.nextLandedOrder(task.coordinatorTaskId),
        summary: input.summary,
        verification: input.verification,
      };
      task.landedMetadata = metadata;
      task.landingState = 'landed_cleanup_failed';
      task.landingReason = `Self-landing merged but landed commit could not be resolved: ${reason}`;
      this.syncLandingState(task);
      throw new Error(task.landingReason);
    }

    const metadata = {
      taskId: task.id,
      taskName: task.name,
      coordinatorTaskId: task.coordinatorTaskId,
      targetBranch: mergeResult.mainBranch,
      landedCommit,
      landedAt: new Date().toISOString(),
      landedOrder: this.nextLandedOrder(task.coordinatorTaskId),
      summary: input.summary,
      verification: input.verification,
    };
    task.landedMetadata = metadata;
    task.landingState = 'reviewed';
    task.landingReason = undefined;

    try {
      await this.host.cleanupLandedTaskResources(task, {
        linesAdded: mergeResult.linesAdded,
        linesRemoved: mergeResult.linesRemoved,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      task.landingState = 'landed_cleanup_failed';
      task.landingReason = reason;
      this.syncLandingState(task);
      throw new Error(`Self-landing merged but cleanup failed: ${reason}`);
    }

    return {
      mainBranch: mergeResult.mainBranch,
      linesAdded: mergeResult.linesAdded,
      linesRemoved: mergeResult.linesRemoved,
      landingState: 'reviewed',
      landedMetadata: metadata,
    };
  }

  markTaskReviewed(taskId: string): void {
    const task = this.host.tasks.get(taskId);
    if (!task || task.landingState !== 'landed_pending_review') return;
    task.landingState = 'reviewed';
    task.landingReason = undefined;
    this.syncLandingState(task);
  }

  async mergeTaskUnchecked(
    taskId: string,
    opts:
      | { squash?: boolean; message?: string; cleanup?: boolean; skipVerification?: boolean }
      | undefined,
    epoch: number,
  ): Promise<{ mainBranch: string; linesAdded: number; linesRemoved: number }> {
    const task = this.host.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.integrationPolicy === 'review')
      throw new Error(
        'This result requires explicit user approval through the desktop review action.',
      );
    if (!this.host.coordinators.has(task.coordinatorTaskId))
      throw new Error('The parent is unavailable; integration is disabled.');
    this.assertTaskCanBeMerged(task);

    // Strip injected preamble files before staging so they don't land in history,
    // then auto-commit any uncommitted changes in the task worktree before merging.
    if (task.worktreePath) {
      await stripPreambleFromBranch(task);
      try {
        this.host.assertOrchestrationEnabled(epoch);
        await execAsync('git', ['add', '-A'], { cwd: task.worktreePath });
        this.host.assertOrchestrationEnabled(epoch);
        await execAsync('git', ['commit', '-m', 'WIP: auto-commit before merge'], {
          cwd: task.worktreePath,
        });
      } catch {
        // Commit failed — check if uncommitted changes still exist
        const { stdout: statusOut } = await execAsync(
          'git',
          ['--no-optional-locks', 'status', '--porcelain'],
          {
            cwd: task.worktreePath,
          },
        );
        if (statusOut.trim()) {
          throw new Error(
            `Auto-commit failed and the task worktree still has uncommitted changes. ` +
              `Please commit or discard changes in ${task.worktreePath} before merging.`,
          );
        }
        // Nothing to commit — swallow silently
      }
    }
    // skipVerification is the coordinator's way past a failure the task cannot
    // fix, such as a suite that is already red on the base branch.
    if (!opts?.skipVerification)
      await this.verifyBeforeLanding(task, () => this.host.assertOrchestrationEnabled(epoch));

    const result = await this.runGitMerge(task, opts, () =>
      this.host.assertOrchestrationEnabled(epoch),
    );

    if (opts?.cleanup) {
      try {
        await this.host.cleanupTask(taskId, {
          linesAdded: result.linesAdded,
          linesRemoved: result.linesRemoved,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Merged into ${result.mainBranch}, but cleanup failed: ${reason}. Call close_task to retry the cleanup.`,
        );
      }
    }

    return {
      mainBranch: result.mainBranch,
      linesAdded: result.linesAdded,
      linesRemoved: result.linesRemoved,
    };
  }

  /** The user merged this child through the desktop Finish dialog; that merge is the review. */
  recordUserMerge(taskId: string): void {
    const task = this.host.tasks.get(taskId);
    if (!task || task.landingState === 'reviewed') return;
    task.landingState = 'reviewed';
    task.landingReason = undefined;
    this.syncLandingState(task);
    this.host.notifications.suppressPendingNotificationForTask(task, true);
  }

  private assertTaskCanBeMerged(task: CoordinatedTask): void {
    if (
      task.landingState === 'landed_pending_review' ||
      task.landingState === 'landed_cleanup_failed' ||
      task.landingState === 'reviewed'
    ) {
      throw new Error(`Task ${task.id} has already landed; review or repair cleanup instead.`);
    }

    const hasManualReviewSignal = task.signalDoneAt !== undefined;
    // landing_escalated unlocks merge_task as an escape hatch for the coordinator.
    // This is not an authority leak: sub-task tokens can only reach land_self (via
    // the /api/tasks/:id/land endpoint); merge_task is a coordinator-only MCP tool,
    // so only a coordinator agent can invoke it here.
    const hasLandingEscalation =
      task.landingState === 'landing_escalated' || task.landingState === 'landing_failed';
    if (task.status === 'running' && !hasManualReviewSignal && !hasLandingEscalation) {
      throw new Error(
        `Task ${task.id} is still running. Use send_prompt for follow-up, or wait until the task signals manual review or reaches a terminal state before calling merge_task.`,
      );
    }
    if (task.status === 'creating') {
      throw new Error(`Task ${task.id} is still starting and cannot be merged yet.`);
    }
  }
}
