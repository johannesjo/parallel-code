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

/**
 * Extract structured selection info from the current DOM selection
 * within a plan viewer container. Returns null if no valid selection.
 */
export function getPlanSelection(containerEl: HTMLElement, source: string): PlanSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return null;

  const range = selection.getRangeAt(0);
  if (!containerEl.contains(range.commonAncestorContainer)) return null;

  const selectedText = selection.toString().trim();
  if (!selectedText) return null;

  const nearestHeading = findNearestHeading(containerEl, range.startContainer);
  const blocks = containerEl.querySelectorAll(BLOCK_SELECTOR);
  const blockIndex = countBlocksBefore(blocks, range.startContainer);
  const endBlockIndex = countBlocksBefore(blocks, range.endContainer);

  return {
    source,
    selectedText,
    nearestHeading,
    startLine: blockIndex,
    endLine: Math.max(blockIndex, endBlockIndex),
  };
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
function countBlocksBefore(blocks: NodeListOf<Element>, node: Node): number {
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
