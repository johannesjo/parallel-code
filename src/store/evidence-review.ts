import { IPC } from '../../electron/ipc/channels';
import type { EvidenceReview } from '../../electron/shared/evidence';
import { DEFAULT_EVIDENCE_MODEL } from '../../electron/shared/evidence-settings';
import {
  startEvidenceModelRequest,
  type EvidenceModelRequest,
} from '../lib/evidence-model-request';
import { buildEvidenceReviewPrompt, parseEvidenceReview } from '../lib/evidence-review';
import { invoke } from '../lib/ipc';
import { errMessage } from '../lib/log';
import { store } from './core';
import { updateEvidence } from './evidence-state';
import { saveState } from './persistence';
import { getProject } from './projects';

const reviews = new Map<string, EvidenceModelRequest>();

/** A rebuild makes the running review moot. */
export function cancelEvidenceReview(taskId: string): void {
  reviews.get(taskId)?.cancel();
}

function setReview(taskId: string, packageId: string, review: EvidenceReview): void {
  updateEvidence(taskId, packageId, (pkg) => {
    pkg.review = review;
  });
}

/** Asks the configured model for a test summary and cited findings. */
export async function runEvidenceReview(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  const pkg = task?.evidence;
  if (!task || !pkg || pkg.assembling || pkg.review?.status === 'running') return;
  const settings = getProject(task.projectId)?.evidenceModel ?? DEFAULT_EVIDENCE_MODEL;
  const running: EvidenceReview = {
    status: 'running',
    provider: settings.provider,
    model: settings.model,
    effort: settings.effort,
    headSha: pkg.scan.headSha,
    findings: [],
  };
  setReview(taskId, pkg.id, running);
  try {
    const diff = await invoke<string>(IPC.GetAllFileDiffs, {
      worktreePath: task.worktreePath,
      baseBranch: task.baseBranch,
    });
    const current = store.tasks[taskId]?.evidence ?? pkg;
    const request = startEvidenceModelRequest({
      prompt: buildEvidenceReviewPrompt(current, diff, settings.guidance),
      cwd: task.worktreePath,
      settings,
      agentEnvFiles: store.agentEnvFiles,
    });
    reviews.set(taskId, request);
    const parsed = parseEvidenceReview(await request.result, pkg.scan);
    setReview(taskId, pkg.id, {
      ...running,
      ...parsed,
      status: 'done',
      finishedAt: new Date().toISOString(),
    });
  } catch (err) {
    setReview(taskId, pkg.id, {
      ...running,
      status: 'error',
      error: errMessage(err),
      finishedAt: new Date().toISOString(),
    });
  } finally {
    reviews.delete(taskId);
  }
  void saveState();
}
