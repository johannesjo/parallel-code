export interface DiffSelection {
  filePath: string;
  startLine: number;
  endLine: number;
  selectedText: string;
}

/**
 * Extract structured selection info from the current DOM selection
 * within the diff viewer. Returns null if no valid diff lines are selected.
 */
export function getDiffSelection(): DiffSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  let ancestor: Node | null = range.commonAncestorContainer;

  // Text nodes don't have element methods — walk up
  if (ancestor.nodeType === Node.TEXT_NODE) {
    ancestor = ancestor.parentNode;
  }
  if (!ancestor || !(ancestor instanceof HTMLElement)) return null;

  // If ancestor IS a diff line (single-line selection), handle directly
  const singleLine = ancestor.closest?.('[data-new-line]');
  if (singleLine) {
    const lineType = singleLine.getAttribute('data-line-type');
    if (lineType === 'remove') return null;
    const lineNum = Number(singleLine.getAttribute('data-new-line'));
    const filePath = singleLine.getAttribute('data-file-path') ?? '';
    return {
      filePath,
      startLine: lineNum,
      endLine: lineNum,
      selectedText: selection.toString(),
    };
  }

  // Multi-line selection: walk the subtree with TreeWalker
  const walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node: Node): number {
      const el = node as HTMLElement;
      if (!el.hasAttribute('data-new-line')) return NodeFilter.FILTER_SKIP;
      if (el.getAttribute('data-line-type') === 'remove') return NodeFilter.FILTER_SKIP;
      if (!range.intersectsNode(el)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let startLine = Infinity;
  let endLine = -Infinity;
  let filePath = '';
  const seenFilePaths = new Set<string>();
  let node = walker.nextNode();

  while (node) {
    const el = node as HTMLElement;
    const lineNum = Number(el.getAttribute('data-new-line'));
    const fp = el.getAttribute('data-file-path') ?? '';
    seenFilePaths.add(fp);
    if (lineNum < startLine) {
      startLine = lineNum;
      filePath = fp;
    }
    if (lineNum > endLine) {
      endLine = lineNum;
    }
    node = walker.nextNode();
  }

  // Reject selections spanning multiple files
  if (startLine === Infinity || seenFilePaths.size > 1) return null;

  return {
    filePath,
    startLine,
    endLine,
    selectedText: selection.toString(),
  };
}
