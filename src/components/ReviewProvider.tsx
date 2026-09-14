import {
  createContext,
  createSignal,
  createEffect,
  createMemo,
  onCleanup,
  untrack,
  useContext,
} from 'solid-js';
import type { JSX } from 'solid-js';
import { sendPrompt } from '../store/tasks';
import {
  compileQualityFindingPrompt,
  dismissQualityFinding,
  reconcileQualityFindingsForDiff,
  resolveQualityFindings,
  selectedFindingIdsAfterSubmission,
  selectSubmittableFindings,
  type QualityFinding,
  type QualityFindingProvider,
} from '../lib/quality-findings';
import {
  transitionReviewAnnotations,
  type ReviewDiffIdentity,
  type ReviewDiffSnapshot,
} from '../lib/diff-review-lifecycle';
import type { FileDiff } from '../lib/unified-diff-parser';
import type { ReviewAnnotation, DiffInteractionMode } from './review-types';

/** Generic selection info used to create annotations or questions. */
export interface ContentSelection {
  source: string;
  startLine: number;
  endLine: number;
  selectedText: string;
}

/** Represents an active ask-about-code question displayed inline. */
export interface ActiveQuestion {
  id: string;
  source: string;
  afterLine: number;
  question: string;
  startLine: number;
  endLine: number;
  selectedText: string;
  /** Absolute paths of images attached to the question, if any. */
  imagePaths?: string[];
}

export interface ReviewScrollTarget {
  id?: string;
  filePath: string;
  startLine: number;
  endLine?: number;
}

export interface ReviewContextValue {
  annotations: () => ReviewAnnotation[];
  addAnnotation: (annotation: ReviewAnnotation) => void;
  dismissAnnotation: (id: string) => void;
  updateAnnotation: (id: string, comment: string) => void;
  replaceAnnotations: (fn: (prev: ReviewAnnotation[]) => ReviewAnnotation[]) => void;

  sidebarOpen: () => boolean;
  setSidebarOpen: (open: boolean) => void;

  findings: () => QualityFinding[];
  openFindings: () => QualityFinding[];
  selectedFindingIds: () => ReadonlySet<string>;
  setFindingSelected: (id: string, selected: boolean) => void;
  dismissFinding: (id: string) => void;
  replaceFindings: (fn: (prev: QualityFinding[]) => QualityFinding[]) => void;
  findingsLoading: () => boolean;
  findingsError: () => string;
  clearFindingsError: () => void;
  refreshFindings: () => void;

  beginDiffLoad: () => void;
  completeDiffLoad: (diffIdentity: string, files: FileDiff[]) => void;
  suspendDiffLoad: () => void;

  scrollTarget: () => ReviewScrollTarget | null;
  setScrollTarget: (target: ReviewScrollTarget | null) => void;

  submitReview: () => Promise<void>;
  canSubmit: () => boolean;
  submitting: () => boolean;

  pendingSelection: () => ContentSelection | null;
  handleSelection: (selection: ContentSelection) => void;
  clearPendingSelection: () => void;

  handleSubmit: (text: string, mode: DiffInteractionMode, imagePaths?: string[]) => string | null;

  activeQuestions: () => ActiveQuestion[];
  dismissQuestion: (id: string) => void;

  submitError: () => string;
  clearSubmitError: () => void;
}

interface ReviewProviderProps {
  taskId?: string;
  agentId?: string;
  findingProvider?: QualityFindingProvider;
  /** Stable task/worktree identity. Durable review state never crosses this boundary. */
  reviewIdentity?: string;
  /** Whether the review surface is currently mounted and interactive. */
  open?: boolean;
  compilePrompt: (annotations: ReviewAnnotation[]) => string;
  onSubmitted?: () => void;
  children: JSX.Element;
}

const ReviewContext = createContext<ReviewContextValue>();

function createReviewSubmissionGuard() {
  const [submitting, setSubmitting] = createSignal(false);

  async function run(action: () => Promise<void>): Promise<boolean> {
    if (submitting()) return false;
    setSubmitting(true);
    try {
      await action();
      return true;
    } finally {
      setSubmitting(false);
    }
  }

  return { submitting, run };
}

function canSubmitReview(
  taskId: string | undefined,
  agentId: string | undefined,
  submitting: boolean,
): boolean {
  return Boolean(taskId && agentId && !submitting);
}

export function ReviewProvider(props: ReviewProviderProps) {
  const [annotations, setAnnotations] = createSignal<ReviewAnnotation[]>([]);
  const [findings, setFindings] = createSignal<QualityFinding[]>([]);
  const [selectedFindingIds, setSelectedFindingIds] = createSignal<ReadonlySet<string>>(new Set());
  const [findingsLoading, setFindingsLoading] = createSignal(false);
  const [findingsError, setFindingsError] = createSignal('');
  const [sidebarOpen, setSidebarOpen] = createSignal(false);
  const [scrollTarget, setScrollTarget] = createSignal<ReviewScrollTarget | null>(null, {
    equals: false,
  });
  const [pendingSelection, setPendingSelection] = createSignal<ContentSelection | null>(null);
  const [activeQuestions, setActiveQuestions] = createSignal<ActiveQuestion[]>([]);
  const [submitError, setSubmitError] = createSignal('');
  const submission = createReviewSubmissionGuard();
  const openFindings = createMemo(() => findings().filter((finding) => finding.state === 'open'));
  let findingLoadGeneration = 0;
  let activeReviewDiff: ReviewDiffSnapshot | null = null;
  let findingsLoadedFor: ReviewDiffIdentity | null = null;
  let findingsLoadedProvider: QualityFindingProvider | undefined;
  let trackedReviewIdentity = untrack(() => props.reviewIdentity ?? '');
  let wasOpen = untrack(() => props.open ?? true);
  let reviewLifecycleGeneration = 0;

  function invalidateFindingLoad() {
    findingLoadGeneration++;
    setFindingsLoading(false);
  }

  function resetTransientState() {
    setSelectedFindingIds(new Set<string>());
    setSidebarOpen(false);
    setScrollTarget(null);
    setPendingSelection(null);
    setActiveQuestions([]);
    setSubmitError('');
    setFindingsError('');
  }

  function clearReviewState() {
    reviewLifecycleGeneration++;
    invalidateFindingLoad();
    setAnnotations([]);
    setFindings([]);
    activeReviewDiff = null;
    findingsLoadedFor = null;
    findingsLoadedProvider = undefined;
    resetTransientState();
  }

  createEffect(() => {
    const reviewIdentity = props.reviewIdentity ?? '';
    if (reviewIdentity === trackedReviewIdentity) return;
    trackedReviewIdentity = reviewIdentity;
    clearReviewState();
  });

  createEffect(() => {
    const open = props.open ?? true;
    if (open === wasOpen) return;
    wasOpen = open;
    if (open) {
      resetTransientState();
    } else {
      suspendDiffLoad();
    }
  });

  onCleanup(invalidateFindingLoad);

  // Auto-open sidebar when human comments or provider findings are added.
  createEffect(() => {
    if (annotations().length > 0 || openFindings().length > 0) setSidebarOpen(true);
  });

  createEffect(() => {
    const validIds = new Set(
      openFindings()
        .filter((finding) => finding.freshness === 'current')
        .map((finding) => finding.id),
    );
    setSelectedFindingIds((prev) => {
      const next = new Set([...prev].filter((id) => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  });

  function addAnnotation(annotation: ReviewAnnotation) {
    setAnnotations((prev) => [...prev, annotation]);
  }

  function dismissAnnotation(id: string) {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
  }

  function updateAnnotation(id: string, comment: string) {
    setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, comment } : a)));
  }

  function replaceAnnotations(fn: (prev: ReviewAnnotation[]) => ReviewAnnotation[]) {
    setAnnotations(fn);
  }

  function setFindingSelected(id: string, selected: boolean) {
    setSelectedFindingIds((prev) => {
      const next = new Set(prev);
      if (selected) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function dismissFinding(id: string) {
    setFindings((prev) => dismissQualityFinding(prev, id));
    setFindingSelected(id, false);
  }

  function replaceFindings(fn: (prev: QualityFinding[]) => QualityFinding[]) {
    setFindings(fn);
  }

  function sameReviewDiff(
    left: ReviewDiffIdentity | null,
    right: ReviewDiffIdentity | null,
  ): boolean {
    return Boolean(
      left &&
      right &&
      left.reviewIdentity === right.reviewIdentity &&
      left.diffIdentity === right.diffIdentity,
    );
  }

  function beginDiffLoad() {
    reviewLifecycleGeneration++;
    invalidateFindingLoad();
    setFindings((prev) => reconcileQualityFindingsForDiff(prev, [], false));
    resetTransientState();
  }

  function loadFindingsForDiff(next: ReviewDiffIdentity, files: FileDiff[]) {
    const provider = props.findingProvider;
    if (!provider) {
      setFindings([]);
      setFindingsLoading(false);
      findingsLoadedFor = next;
      findingsLoadedProvider = undefined;
      return;
    }

    const generation = ++findingLoadGeneration;
    setFindingsError('');
    setFindingsLoading(true);
    void provider
      .loadFindings({
        reviewIdentity: next.reviewIdentity,
        diffIdentity: next.diffIdentity,
        files,
      })
      .then((loaded) => {
        if (
          generation !== findingLoadGeneration ||
          !sameReviewDiff(activeReviewDiff, next) ||
          !wasOpen
        ) {
          return;
        }
        const reconciled = reconcileQualityFindingsForDiff(
          loaded,
          files,
          true,
          next.diffIdentity,
          activeReviewDiff?.diffIdentity,
        );
        findingsLoadedFor = next;
        findingsLoadedProvider = provider;
        setFindings(reconciled);
        setSidebarOpen(
          untrack(annotations).length > 0 ||
            reconciled.some(
              (finding) => finding.state === 'open' && finding.freshness === 'current',
            ),
        );
      })
      .catch((err: unknown) => {
        if (generation !== findingLoadGeneration || !sameReviewDiff(activeReviewDiff, next)) {
          return;
        }
        setFindings([]);
        setFindingsError(err instanceof Error ? err.message : 'Failed to load quality findings');
        setSidebarOpen(true);
      })
      .finally(() => {
        if (generation === findingLoadGeneration) setFindingsLoading(false);
      });
  }

  function refreshFindings() {
    const current = activeReviewDiff;
    if (!current || !props.findingProvider) return;
    invalidateFindingLoad();
    setFindings([]);
    setSelectedFindingIds(new Set<string>());
    findingsLoadedFor = null;
    findingsLoadedProvider = undefined;
    loadFindingsForDiff(current, current.files);
  }

  function completeDiffLoad(diffIdentity: string, files: FileDiff[]) {
    const next: ReviewDiffSnapshot = {
      reviewIdentity: props.reviewIdentity ?? '',
      diffIdentity,
      files,
    };
    const sameDiff = sameReviewDiff(activeReviewDiff, next);

    if (!sameDiff) reviewLifecycleGeneration++;

    setAnnotations((prev) => transitionReviewAnnotations(prev, activeReviewDiff, next));
    activeReviewDiff = next;

    if (!sameDiff) {
      invalidateFindingLoad();
      setFindings([]);
      setSelectedFindingIds(new Set<string>());
      findingsLoadedFor = null;
      findingsLoadedProvider = undefined;
    } else if (
      sameReviewDiff(findingsLoadedFor, next) &&
      findingsLoadedProvider === props.findingProvider
    ) {
      setFindings((prev) =>
        reconcileQualityFindingsForDiff(
          prev,
          files,
          true,
          findingsLoadedFor?.diffIdentity,
          diffIdentity,
        ),
      );
      setSidebarOpen(
        annotations().length > 0 ||
          findings().some((finding) => finding.state === 'open' && finding.freshness === 'current'),
      );
      return;
    }

    loadFindingsForDiff(next, files);
  }

  function suspendDiffLoad() {
    reviewLifecycleGeneration++;
    invalidateFindingLoad();
    setFindings((prev) => reconcileQualityFindingsForDiff(prev, [], false));
    resetTransientState();
  }

  function handleSelection(selection: ContentSelection) {
    setPendingSelection(selection);
  }

  function clearPendingSelection() {
    setPendingSelection(null);
  }

  /** Create an annotation or question from the pending selection. Returns the new item's ID, or null on no-op. */
  function handleSubmit(
    text: string,
    mode: DiffInteractionMode,
    imagePaths?: string[],
  ): string | null {
    const sel = pendingSelection();
    if (!sel) return null;

    const id = crypto.randomUUID();
    if (mode === 'review') {
      addAnnotation({
        id,
        filePath: sel.source,
        startLine: sel.startLine,
        endLine: sel.endLine,
        selectedText: sel.selectedText,
        comment: text,
      });
    } else {
      setActiveQuestions((prev) => [
        ...prev,
        {
          id,
          source: sel.source,
          afterLine: sel.endLine,
          question: text,
          startLine: sel.startLine,
          endLine: sel.endLine,
          selectedText: sel.selectedText,
          imagePaths: imagePaths?.length ? [...imagePaths] : undefined,
        },
      ]);
    }

    setPendingSelection(null);
    window.getSelection()?.removeAllRanges();
    return id;
  }

  function dismissQuestion(id: string) {
    setActiveQuestions((prev) => prev.filter((q) => q.id !== id));
  }

  function canSubmit(): boolean {
    return canSubmitReview(props.taskId, props.agentId, submission.submitting());
  }

  async function submitReview(): Promise<void> {
    const taskId = props.taskId;
    const agentId = props.agentId;
    if (!taskId || !agentId) return;
    const submittedAnnotations = annotations();
    const submittedFindings = selectSubmittableFindings(findings(), selectedFindingIds());
    if (submittedAnnotations.length === 0 && submittedFindings.length === 0) return;

    const prompt = [
      submittedAnnotations.length > 0 ? props.compilePrompt(submittedAnnotations) : '',
      submittedFindings.length > 0 ? compileQualityFindingPrompt(submittedFindings) : '',
    ]
      .filter(Boolean)
      .join('\n');
    const submittedAnnotationIds = new Set(submittedAnnotations.map((annotation) => annotation.id));
    const onSubmitted = props.onSubmitted;
    const submittedReviewLifecycle = reviewLifecycleGeneration;

    await submission.run(async () => {
      setSubmitError('');
      try {
        await sendPrompt(taskId, agentId, prompt);
        if (submittedReviewLifecycle !== reviewLifecycleGeneration) return;
        const remainingAnnotations = untrack(annotations).filter(
          (annotation) => !submittedAnnotationIds.has(annotation.id),
        );
        const updatedFindings = resolveQualityFindings(untrack(findings), submittedFindings);
        setAnnotations(remainingAnnotations);
        setFindings(updatedFindings);
        setSelectedFindingIds((previous) =>
          selectedFindingIdsAfterSubmission(previous, submittedFindings),
        );
        const hasRemainingActionableReview =
          remainingAnnotations.length > 0 ||
          updatedFindings.some(
            (finding) => finding.state === 'open' && finding.freshness === 'current',
          );
        setSidebarOpen(hasRemainingActionableReview);
        if (!hasRemainingActionableReview) onSubmitted?.();
      } catch (err: unknown) {
        if (submittedReviewLifecycle !== reviewLifecycleGeneration) return;
        setSubmitError(err instanceof Error ? err.message : 'Failed to send review');
        setSidebarOpen(true);
      }
    });
  }

  const value: ReviewContextValue = {
    annotations,
    addAnnotation,
    dismissAnnotation,
    updateAnnotation,
    replaceAnnotations,
    findings,
    openFindings,
    selectedFindingIds,
    setFindingSelected,
    dismissFinding,
    replaceFindings,
    findingsLoading,
    findingsError,
    clearFindingsError: () => setFindingsError(''),
    refreshFindings,
    beginDiffLoad,
    completeDiffLoad,
    suspendDiffLoad,
    sidebarOpen,
    setSidebarOpen,
    scrollTarget,
    setScrollTarget,
    pendingSelection,
    handleSelection,
    clearPendingSelection,
    handleSubmit,
    activeQuestions,
    dismissQuestion,
    canSubmit,
    submitting: submission.submitting,
    submitReview,
    submitError,
    clearSubmitError: () => setSubmitError(''),
  };

  return <ReviewContext.Provider value={value}>{props.children}</ReviewContext.Provider>;
}

export function useReview(): ReviewContextValue {
  const ctx = useContext(ReviewContext);
  if (!ctx) {
    throw new Error('useReview must be used within a ReviewProvider');
  }
  return ctx;
}
