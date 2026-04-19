import { createContext, createSignal, createEffect, useContext } from 'solid-js';
import type { JSX } from 'solid-js';
import { sendPrompt } from '../store/tasks';
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
}

export interface ReviewContextValue {
  annotations: () => ReviewAnnotation[];
  addAnnotation: (annotation: ReviewAnnotation) => void;
  dismissAnnotation: (id: string) => void;
  updateAnnotation: (id: string, comment: string) => void;
  replaceAnnotations: (fn: (prev: ReviewAnnotation[]) => ReviewAnnotation[]) => void;

  sidebarOpen: () => boolean;
  setSidebarOpen: (open: boolean) => void;

  scrollTarget: () => ReviewAnnotation | null;
  setScrollTarget: (target: ReviewAnnotation | null) => void;

  submitReview: () => Promise<void>;
  canSubmit: () => boolean;

  pendingSelection: () => ContentSelection | null;
  handleSelection: (selection: ContentSelection) => void;
  clearPendingSelection: () => void;

  handleSubmit: (text: string, mode: DiffInteractionMode) => string | null;

  activeQuestions: () => ActiveQuestion[];
  dismissQuestion: (id: string) => void;

  submitError: () => string;
}

interface ReviewProviderProps {
  taskId?: string;
  agentId?: string;
  compilePrompt: (annotations: ReviewAnnotation[]) => string;
  onSubmitted?: () => void;
  children: JSX.Element;
}

const ReviewContext = createContext<ReviewContextValue>();

export function ReviewProvider(props: ReviewProviderProps) {
  const [annotations, setAnnotations] = createSignal<ReviewAnnotation[]>([]);
  const [sidebarOpen, setSidebarOpen] = createSignal(false);
  const [scrollTarget, setScrollTarget] = createSignal<ReviewAnnotation | null>(null, {
    equals: false,
  });
  const [pendingSelection, setPendingSelection] = createSignal<ContentSelection | null>(null);
  const [activeQuestions, setActiveQuestions] = createSignal<ActiveQuestion[]>([]);
  const [submitError, setSubmitError] = createSignal('');

  // Auto-open sidebar when annotations are added
  createEffect(() => {
    if (annotations().length > 0) setSidebarOpen(true);
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

  function handleSelection(selection: ContentSelection) {
    setPendingSelection(selection);
  }

  function clearPendingSelection() {
    setPendingSelection(null);
  }

  /** Create an annotation or question from the pending selection. Returns the new item's ID, or null on no-op. */
  function handleSubmit(text: string, mode: DiffInteractionMode): string | null {
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
    return !!props.taskId && !!props.agentId;
  }

  async function submitReview(): Promise<void> {
    const taskId = props.taskId;
    const agentId = props.agentId;
    if (!taskId || !agentId) return;

    setSubmitError('');
    const prompt = props.compilePrompt(annotations());
    try {
      await sendPrompt(taskId, agentId, prompt);
      setAnnotations([]);
      setSidebarOpen(false);
      props.onSubmitted?.();
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to send review');
    }
  }

  const value: ReviewContextValue = {
    annotations,
    addAnnotation,
    dismissAnnotation,
    updateAnnotation,
    replaceAnnotations,
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
    submitReview,
    submitError,
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
