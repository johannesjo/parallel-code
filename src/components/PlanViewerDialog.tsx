import { Show, For, createSignal, createEffect } from 'solid-js';
import { Dialog } from './Dialog';
import { createDialogScroll } from '../lib/dialog-scroll';
import { ReviewProvider, useReview } from './ReviewProvider';
import { ReviewCommentsButton, ReviewSidebarPanel } from './ReviewSidebarPanel';
import { ReviewCommentCard } from './ReviewCommentCard';
import { InlineInput } from './InlineInput';
import { AskCodeCard } from './AskCodeCard';
import { CloseIcon } from './icons';
import { createHighlightedMarkdown } from '../lib/marked-shiki';
import { getPlanSelection } from '../lib/plan-selection';
import { openFileInEditor } from '../lib/shell';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import type { ReviewAnnotation } from './review-types';

interface PlanViewerDialogProps {
  open: boolean;
  onClose: () => void;
  planContent: string;
  planFileName: string;
  taskId?: string;
  agentId?: string;
  worktreePath?: string;
}

/** Compile review annotations into a prompt string for the agent. */
function compilePlanReview(annotations: ReviewAnnotation[]): string {
  const lines = ['Feedback on the implementation plan:\n'];
  for (const a of annotations) {
    lines.push(`## ${a.filePath}`);
    lines.push('> ' + a.selectedText.split('\n').join('\n> '));
    lines.push('');
    lines.push(a.comment);
    lines.push('');
  }
  return lines.join('\n');
}

export function PlanViewerDialog(props: PlanViewerDialogProps) {
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      width="fit-content"
      panelStyle={{
        height: '70vh',
        'min-width': '360px',
        'max-width': '1000px',
        overflow: 'hidden',
        padding: '0',
        gap: '0',
      }}
    >
      <Show when={props.open}>
        <ReviewProvider
          taskId={props.taskId}
          agentId={props.agentId}
          compilePrompt={compilePlanReview}
          onSubmitted={props.onClose}
        >
          <PlanViewerContent
            planContent={props.planContent}
            planFileName={props.planFileName}
            worktreePath={props.worktreePath}
            onClose={props.onClose}
          />
        </ReviewProvider>
      </Show>
    </Dialog>
  );
}

interface PlanViewerContentProps {
  planContent: string;
  planFileName: string;
  worktreePath?: string;
  onClose: () => void;
}

/** Inner content rendered inside ReviewProvider so it can call useReview(). */
interface HighlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function PlanViewerContent(props: PlanViewerContentProps) {
  const review = useReview();
  const planHtml = createHighlightedMarkdown(() => props.planContent);

  let contentRef: HTMLDivElement | undefined;
  let scrollRef: HTMLDivElement | undefined;

  const [selectionY, setSelectionY] = createSignal(0);
  const [cardOffsets, setCardOffsets] = createSignal<Record<string, number>>({});
  const [highlightRects, setHighlightRects] = createSignal<HighlightRect[]>([]);

  createDialogScroll(
    () => scrollRef,
    () => !!props.planContent,
  );

  // Render mermaid blocks after HTML is inserted
  createEffect(() => {
    void planHtml(); // track dependency
    if (!contentRef) return;
    const blocks = contentRef.querySelectorAll('.mermaid-block');
    if (blocks.length === 0) return;
    import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: 'dark' });
      blocks.forEach((el, i) => {
        const source = el.getAttribute('data-mermaid');
        if (!source) return;
        const id = `mermaid-plan-${Date.now()}-${i}`;
        mermaid.render(id, source).then(({ svg }) => {
          el.innerHTML = svg; // nosemgrep: semgrep.no-inner-html-without-sanitize -- mermaid renders its own sanitized SVG; source is plan text not user HTML
          el.classList.add('mermaid-rendered');
        });
      });
    });
  });

  // Scroll to annotation when scrollTarget changes
  createEffect(() => {
    const target = review.scrollTarget();
    if (!target?.id) return;
    const y = cardOffsets()[target.id];
    if (y !== undefined && scrollRef) {
      scrollRef.scrollTo({ top: Math.max(0, y - 100), behavior: 'smooth' });
    }
  });

  // Clear highlight overlays when pending selection is dismissed
  createEffect(() => {
    if (!review.pendingSelection()) setHighlightRects([]);
  });

  /** Capture selection rects and Y offset relative to contentRef. */
  function captureSelectionGeometry(): { y: number; rects: HighlightRect[] } {
    const domSel = window.getSelection();
    if (!domSel || domSel.rangeCount === 0 || !contentRef) return { y: 0, rects: [] };
    const range = domSel.getRangeAt(0);
    const containerRect = contentRef.getBoundingClientRect();
    const rangeRect = range.getBoundingClientRect();
    const y = rangeRect.bottom - containerRect.top;
    const clientRects = range.getClientRects();
    const rects: HighlightRect[] = [];
    for (let i = 0; i < clientRects.length; i++) {
      const r = clientRects[i];
      rects.push({
        top: r.top - containerRect.top,
        left: r.left - containerRect.left,
        width: r.width,
        height: r.height,
      });
    }
    return { y, rects };
  }

  function handleMouseUp() {
    if (!contentRef) return;
    const sel = getPlanSelection(contentRef, props.planFileName);
    if (!sel) return;

    const { y, rects } = captureSelectionGeometry();
    setSelectionY(y);
    setHighlightRects(rects);
    // Clear native selection — overlay rects provide the visual highlight from here
    window.getSelection()?.removeAllRanges();

    const source = sel.nearestHeading
      ? `${props.planFileName} \u00A7 ${sel.nearestHeading}`
      : props.planFileName;

    review.handleSelection({
      source,
      startLine: sel.startLine,
      endLine: sel.endLine,
      selectedText: sel.selectedText,
    });
  }

  function handleSubmitWithPosition(
    text: string,
    mode: Parameters<typeof review.handleSubmit>[1],
    imagePaths?: string[],
  ) {
    const y = selectionY();
    const id = review.handleSubmit(text, mode, imagePaths);
    if (id) setCardOffsets((prev) => ({ ...prev, [id]: y }));
    setHighlightRects([]);
  }

  return (
    <>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '10px',
          padding: '12px 20px',
          'border-bottom': `1px solid ${theme.border}`,
          'flex-shrink': '0',
        }}
      >
        <span
          style={{
            'font-size': sf(14),
            color: theme.fg,
            'font-weight': '600',
            'font-family': "'JetBrains Mono', monospace",
          }}
        >
          {props.planFileName}
        </span>

        <ReviewCommentsButton />

        <span style={{ flex: '1' }} />

        <Show when={props.worktreePath}>
          <button
            onClick={() => {
              if (props.worktreePath) openFileInEditor(props.worktreePath, props.planFileName);
            }}
            style={{
              background: 'transparent',
              border: 'none',
              color: theme.fgMuted,
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
              'align-items': 'center',
              'border-radius': '4px',
            }}
            title="Open in editor"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.5 2a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5v-3a.75.75 0 0 1 1.5 0v3A3 3 0 0 1 12.5 16h-9A3 3 0 0 1 0 12.5v-9A3 3 0 0 1 3.5 0h3a.75.75 0 0 1 0 1.5h-3ZM10 .75a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0V2.56L8.53 8.53a.75.75 0 0 1-1.06-1.06L13.44 1.5H10.75A.75.75 0 0 1 10 .75Z" />
            </svg>
          </button>
        </Show>

        <button
          onClick={() => props.onClose()}
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.fgMuted,
            cursor: 'pointer',
            padding: '4px',
            display: 'flex',
            'align-items': 'center',
            'border-radius': '4px',
          }}
          title="Close"
        >
          <CloseIcon />
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: '1', overflow: 'hidden', display: 'flex' }}>
        {/* Scrollable plan content area */}
        <div
          ref={scrollRef}
          style={{
            flex: '1',
            'overflow-y': 'auto',
            padding: '28px 40px',
          }}
        >
          <div style={{ position: 'relative' }}>
            <div
              ref={contentRef}
              class="plan-markdown plan-markdown-dialog"
              style={{
                color: theme.fg,
              }}
              onMouseUp={handleMouseUp}
              // eslint-disable-next-line solid/no-innerhtml -- plan files are local, written by Claude Code in the worktree
              innerHTML={planHtml()}
            />

            {/* Selection highlight overlays — persist after focus moves to inline input */}
            <For each={highlightRects()}>
              {(rect) => (
                <div
                  style={{
                    position: 'absolute',
                    top: `${rect.top}px`,
                    left: `${rect.left}px`,
                    width: `${rect.width}px`,
                    height: `${rect.height}px`,
                    background: 'rgba(100, 149, 237, 0.3)',
                    'pointer-events': 'none',
                    'border-radius': '2px',
                  }}
                />
              )}
            </For>

            {/* Inline input for pending selection — positioned near the selection */}
            <Show when={review.pendingSelection()}>
              <div
                style={{
                  position: 'absolute',
                  top: `${selectionY()}px`,
                  left: '0',
                  right: '0',
                  'z-index': '10',
                }}
              >
                <InlineInput
                  onSubmit={handleSubmitWithPosition}
                  onDismiss={review.clearPendingSelection}
                />
              </div>
            </Show>

            {/* Annotation cards — positioned where the selection was made */}
            <For each={review.annotations()}>
              {(annotation) => (
                <div
                  data-annotation-id={annotation.id}
                  style={{
                    position: 'absolute',
                    top: `${cardOffsets()[annotation.id] ?? 0}px`,
                    left: '0',
                    right: '0',
                    'z-index': '5',
                  }}
                >
                  <ReviewCommentCard
                    annotation={annotation}
                    onDismiss={() => review.dismissAnnotation(annotation.id)}
                    overlay
                  />
                </div>
              )}
            </For>

            {/* Active questions — positioned where the selection was made */}
            <For each={review.activeQuestions()}>
              {(q) => (
                <div
                  style={{
                    position: 'absolute',
                    top: `${cardOffsets()[q.id] ?? 0}px`,
                    left: '0',
                    right: '0',
                    'z-index': '5',
                  }}
                >
                  <AskCodeCard
                    requestId={q.id}
                    question={q.question}
                    filePath={q.source}
                    startLine={q.startLine}
                    endLine={q.endLine}
                    selectedText={q.selectedText}
                    worktreePath={props.worktreePath ?? ''}
                    imagePaths={q.imagePaths}
                    onDismiss={() => review.dismissQuestion(q.id)}
                  />
                </div>
              )}
            </For>
          </div>
        </div>

        {/* Sidebar */}
        <ReviewSidebarPanel />
      </div>
    </>
  );
}
