export interface PlanSelection {
  /** The plan filename or identifier */
  source: string;
  /** Selected text content */
  selectedText: string;
  /** Nearest heading text above the selection (for context) */
  nearestHeading: string;
  /** Block element index for ordering annotations */
  startLine: number;
  endLine: number;
}

const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, pre, tr';
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
export const PLAN_REVIEW_FLOW_SLOT_SELECTOR = '[data-plan-review-flow-slot]';

export interface PlanSelectionRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function getSelectionRange(containerEl: HTMLElement): Range | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  return containerEl.contains(range.commonAncestorContainer) ? range : null;
}

function isInPlanReviewFlowSlot(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return Boolean(element?.closest(PLAN_REVIEW_FLOW_SLOT_SELECTOR));
}

function cloneSelectionWithAncestors(
  containerEl: HTMLElement,
  selectedRange: Range,
): DocumentFragment {
  let fragment = selectedRange.cloneContents();
  let ancestor: Node | null =
    selectedRange.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? selectedRange.commonAncestorContainer.parentNode
      : selectedRange.commonAncestorContainer;

  while (ancestor && ancestor !== containerEl) {
    if (ancestor instanceof Element) {
      const wrapper = ancestor.cloneNode(false) as Element;
      wrapper.append(fragment);
      fragment = document.createDocumentFragment();
      fragment.append(wrapper);
    }
    ancestor = ancestor.parentNode;
  }

  return fragment;
}

function getPlanSelectionVisibleText(containerEl: HTMLElement, selectedRange: Range): string {
  const host = document.createElement('div');
  const fragment = cloneSelectionWithAncestors(containerEl, selectedRange);
  fragment.querySelectorAll(PLAN_REVIEW_FLOW_SLOT_SELECTOR).forEach((node) => node.remove());
  // Deliberate deviation from native selection, measured in Chromium 149. innerText already
  // drops SVG <style> and <title>, but NOT <defs> text — Mermaid parks off-screen labels
  // there and Selection.toString() emits them too, so `defs` here is the only thing keeping
  // them out of the agent prompt. [hidden] and [aria-hidden] are genuinely rendered and do
  // survive innerText; they are dropped on purpose as markup the agent should not read.
  // No local test guards any of this: happy-dom's innerText already omits <defs> text, so
  // the Mermaid case in plan-selection.client.test.tsx passes with or without this line.
  // Removing an entry here needs a browser check, not a green suite.
  fragment
    .querySelectorAll('style, script, defs, metadata, title, desc, [hidden], [aria-hidden="true"]')
    .forEach((node) => node.remove());

  host.className = containerEl.className;
  host.style.cssText = [
    'position:absolute',
    'left:-99999px',
    'top:0',
    'contain:layout style paint',
    `width:${Math.max(containerEl.clientWidth, 1)}px`,
  ].join(';');
  host.append(fragment);

  const parent = containerEl.parentElement ?? document.body;
  parent.append(host);
  try {
    return host.innerText.trim();
  } finally {
    host.remove();
  }
}

/**
 * Return the selected text ranges that belong to plan content, excluding inline review UI.
 * Walks the selection subtree, so callers compute this once per gesture and pass the result
 * to `getPlanSelection` and `getPlanSelectionFlowAnchor` rather than having each re-walk.
 */
export function getPlanSelectionTextRanges(containerEl: HTMLElement): Range[] {
  const selectedRange = getSelectionRange(containerEl);
  if (!selectedRange) return [];

  const ranges: Range[] = [];
  const walkerRoot =
    selectedRange.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? selectedRange.commonAncestorContainer.parentElement
      : selectedRange.commonAncestorContainer;
  const walker = document.createTreeWalker(
    walkerRoot && containerEl.contains(walkerRoot) ? walkerRoot : containerEl,
    NodeFilter.SHOW_TEXT,
  );
  let node = walker.nextNode();
  while (node) {
    const text = node as Text;
    if (!isInPlanReviewFlowSlot(node) && selectedRange.intersectsNode(node)) {
      const start = node === selectedRange.startContainer ? selectedRange.startOffset : 0;
      const end = node === selectedRange.endContainer ? selectedRange.endOffset : text.length;
      if (start < end) {
        const range = document.createRange();
        range.setStart(text, start);
        range.setEnd(text, end);
        if (range.toString().trim()) ranges.push(range);
      }
    }
    node = walker.nextNode();
  }
  return ranges;
}

export function getPlanSelectionRects(
  containerEl: HTMLElement,
  ranges: readonly Range[],
): PlanSelectionRect[] {
  const containerRect = containerEl.getBoundingClientRect();
  const rects: PlanSelectionRect[] = [];
  for (const range of ranges) {
    for (const rect of range.getClientRects()) {
      rects.push({
        top: rect.top - containerRect.top,
        left: rect.left - containerRect.left,
        width: rect.width,
        height: rect.height,
      });
    }
  }
  return rects;
}

/** Keep persisted selection overlays aligned while inline cards reflow the plan. */
export function trackPlanSelectionGeometry(
  containerEl: HTMLElement,
  ranges: readonly Range[],
  onChange: (rects: PlanSelectionRect[]) => void,
): () => void {
  const refresh = () => onChange(getPlanSelectionRects(containerEl, ranges));
  refresh();

  if (typeof ResizeObserver === 'undefined') return () => undefined;
  const observer = new ResizeObserver(refresh);
  observer.observe(containerEl);
  return () => observer.disconnect();
}

/**
 * Extract structured selection info for a plan viewer selection. `textRanges` must come from
 * `getPlanSelectionTextRanges(containerEl)` on the same, unmutated selection: the text and
 * heading are read from the live selection, while the line range is derived from these, so
 * passing stale ranges desynchronizes the two. Returns null if no valid selection.
 */
export function getPlanSelection(
  containerEl: HTMLElement,
  source: string,
  textRanges: readonly Range[],
): PlanSelection | null {
  const range = getSelectionRange(containerEl);
  if (!range) return null;
  // Checked before the offscreen clone below, which forces a layout to read innerText.
  if (textRanges.length === 0) return null;

  const selectedText = getPlanSelectionVisibleText(containerEl, range);
  if (!selectedText) return null;

  const firstTextRange = textRanges[0];
  const lastTextRange = textRanges.at(-1);
  if (!firstTextRange || !lastTextRange) return null;

  const nearestHeading = findNearestHeading(containerEl, range.startContainer);
  const blocks = Array.from(containerEl.querySelectorAll(BLOCK_SELECTOR)).filter(
    (block) => !block.closest(PLAN_REVIEW_FLOW_SLOT_SELECTOR),
  );
  const blockIndex = countBlocksBefore(blocks, firstTextRange.startContainer);
  const endBlockIndex = countBlocksBefore(blocks, lastTextRange.endContainer);

  return {
    source,
    selectedText,
    nearestHeading,
    startLine: blockIndex,
    endLine: Math.max(blockIndex, endBlockIndex),
  };
}

/**
 * Find the block that should own an inline review card for the given selection ranges.
 * Pure with respect to `textRanges` — it does not read the live selection, so unlike the
 * other helpers here it still returns a block after the selection has been cleared.
 */
export function getPlanSelectionFlowAnchor(
  containerEl: HTMLElement,
  textRanges: readonly Range[],
): HTMLElement | null {
  const range = textRanges.at(-1);
  if (!range) return null;

  let element: Element | null =
    range.endContainer.nodeType === Node.ELEMENT_NODE
      ? (range.endContainer as Element)
      : range.endContainer.parentElement;
  if (!element || element.closest(PLAN_REVIEW_FLOW_SLOT_SELECTOR)) return null;

  const block = element.closest(BLOCK_SELECTOR);
  if (block && block !== containerEl && containerEl.contains(block)) {
    // A div cannot be a child of a table row, so place table comments after the table.
    if (block.tagName === 'TR') {
      const table = block.closest('table');
      if (table instanceof HTMLElement && containerEl.contains(table)) return table;
    }
    if (block instanceof HTMLElement) return block;
  }

  // Fallback for rendered blocks such as Mermaid diagrams that are not in BLOCK_SELECTOR.
  while (element.parentElement && element.parentElement !== containerEl) {
    element = element.parentElement;
  }
  return element instanceof HTMLElement && element.parentElement === containerEl ? element : null;
}

/** Walk backwards from the selection start to find the nearest heading. */
function findNearestHeading(container: HTMLElement, startNode: Node): string {
  let node: Node | null = startNode;

  // Walk up to find an element inside container
  while (node && node !== container && !(node instanceof HTMLElement)) {
    node = node.parentNode;
  }

  if (!node || node === container) {
    // Fallback: check if startNode is inside a heading
    return '';
  }

  const el = node as HTMLElement;

  // Check if we're inside a heading
  if (el.matches(HEADING_SELECTOR)) {
    return el.textContent?.trim() ?? '';
  }

  // Walk backwards through previous siblings and parent siblings
  let current: Element | null = el;
  while (current && container.contains(current)) {
    // Check previous siblings
    let sibling: Element | null = current.previousElementSibling;
    while (sibling) {
      // Check if sibling itself is a heading
      if (sibling.matches(HEADING_SELECTOR)) {
        return sibling.textContent?.trim() ?? '';
      }
      // Check for headings inside sibling (last one wins since we walk backwards)
      const headings = sibling.querySelectorAll(HEADING_SELECTOR);
      if (headings.length > 0) {
        return headings[headings.length - 1].textContent?.trim() ?? '';
      }
      sibling = sibling.previousElementSibling;
    }
    // Move to parent and continue
    current = current.parentElement;
    if (current === container) break;
  }

  return '';
}

/** Count block elements before the given node from a pre-queried list. */
function countBlocksBefore(blocks: readonly Element[], node: Node): number {
  let count = 0;
  for (const block of blocks) {
    // Is this block before or containing the node?
    const position = block.compareDocumentPosition(node);
    // If node is contained by or equal to block, stop here
    if (block === node || block.contains(node)) return count;
    // If block is before node (DOCUMENT_POSITION_FOLLOWING means node follows)
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      count++;
    } else {
      break;
    }
  }
  return count;
}
