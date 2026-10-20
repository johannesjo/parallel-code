import type { ReviewAnnotation } from '../components/review-types';
import type { FileDiff } from './unified-diff-parser';

export interface ReviewDiffIdentity {
  reviewIdentity: string;
  diffIdentity: string;
}

export interface ReviewDiffSnapshot extends ReviewDiffIdentity {
  files: FileDiff[];
}

export interface RequestGenerationGuard {
  begin: () => number;
  invalidate: () => void;
  isCurrent: (generation: number) => boolean;
}

export function createRequestGenerationGuard(): RequestGenerationGuard {
  let current = 0;
  return {
    begin: () => ++current,
    invalidate: () => {
      current++;
    },
    isCurrent: (generation) => generation === current,
  };
}

export function createReviewIdentity(parts: {
  taskId?: string;
  worktreePath: string;
  projectRoot?: string;
  branchName?: string | null;
}): string {
  return JSON.stringify([
    parts.taskId ?? null,
    parts.worktreePath,
    parts.projectRoot ?? null,
    parts.branchName ?? null,
  ]);
}

export async function createDiffIdentity(reviewIdentity: string, rawDiff: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${reviewIdentity}\0${rawDiff}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function annotationContentAnchor(annotation: ReviewAnnotation, files: FileDiff[]): string[] | null {
  const file = files.find((candidate) => candidate.path === annotation.filePath);
  if (!file || file.binary || file.status === 'D') return null;

  const contentByLine = new Map<number, string>();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.newLine !== null) contentByLine.set(line.newLine, line.content);
    }
  }

  const content: string[] = [];
  for (let line = annotation.startLine; line <= annotation.endLine; line++) {
    if (!contentByLine.has(line)) return null;
    content.push(contentByLine.get(line) ?? '');
  }
  return content;
}

function sameContentAnchor(previous: string[], next: string[]): boolean {
  return previous.length === next.length && previous.every((line, index) => line === next[index]);
}

export function transitionReviewAnnotations(
  annotations: ReviewAnnotation[],
  previous: ReviewDiffSnapshot | null,
  next: ReviewDiffSnapshot,
): ReviewAnnotation[] {
  if (!previous) return annotations;
  if (previous.reviewIdentity !== next.reviewIdentity) return [];
  if (previous.diffIdentity === next.diffIdentity) return annotations;

  const retained = annotations.filter((annotation) => {
    const previousAnchor = annotationContentAnchor(annotation, previous.files);
    if (!previousAnchor) return false;
    const nextAnchor = annotationContentAnchor(annotation, next.files);
    return nextAnchor !== null && sameContentAnchor(previousAnchor, nextAnchor);
  });
  return retained.length === annotations.length ? annotations : retained;
}
