import { afterEach, describe, expect, it, vi } from 'vitest';
import { Marked } from 'marked';
import {
  getPlanSelection,
  getPlanSelectionFlowAnchor,
  getPlanSelectionTextRanges,
  PLAN_REVIEW_FLOW_SLOT_SELECTOR,
  trackPlanSelectionGeometry,
} from './plan-selection';

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function selectText(start: Text, end: Text): void {
  const range = document.createRange();
  range.setStart(start, 0);
  range.setEnd(end, end.length);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function findTextNode(container: Node, value: string): Text {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node.textContent === value) return node as Text;
    node = walker.nextNode();
  }
  throw new Error(`Could not find text node: ${value}`);
}

function renderPlanMarkdown(markdown: string): HTMLDivElement {
  const container = document.createElement('div');
  container.className = 'plan-markdown plan-markdown-dialog';
  container.innerHTML = new Marked().parse(markdown, { async: false }) as string;
  document.body.append(container);
  return container;
}

function firstTextNodeIn(element: Element): Text {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const node = walker.nextNode();
  if (!node) throw new Error(`Could not find text in ${element.tagName}`);
  return node as Text;
}

function lastTextNodeIn(element: Element): Text {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let last: Node | null = null;
  let node = walker.nextNode();
  while (node) {
    last = node;
    node = walker.nextNode();
  }
  if (!last) throw new Error(`Could not find text in ${element.tagName}`);
  return last as Text;
}

function getNativeSelectionText(): string {
  return window.getSelection()?.toString().trim() ?? '';
}

function selectAllRenderedText(container: HTMLElement): void {
  selectText(firstTextNodeIn(container), lastTextNodeIn(container));
}

function rect(top: number, left = 0): DOMRect {
  return {
    x: left,
    y: top,
    top,
    left,
    right: left + 40,
    bottom: top + 12,
    width: 40,
    height: 12,
    toJSON: () => undefined,
  };
}

describe('plan selection DOM behavior', () => {
  // The full native-parity corpus runs in the browser-mode follow-up. Keeping
  // it here documents the contract without making the happy-dom lane pretend
  // to implement layout and CSS whitespace.
  it.skip.each([
    {
      name: 'paragraphs and headings',
      markdown: '# Goal\n\nFirst paragraph.\n\n## Details\n\nSecond paragraph.',
    },
    {
      name: 'nested and loose lists',
      markdown: '- Parent\n  - Nested child\n\n- Loose item\n\n  Continuation paragraph.',
    },
    {
      name: 'fenced code and blockquotes',
      markdown: '> Quoted step\n\n```ts\nconst ready = true;\n```',
    },
    {
      name: 'inline emphasis, code, and links',
      markdown: '**Bold** *emphasis* `inline code` [linked text](https://example.com)',
    },
    {
      name: 'soft and hard breaks',
      markdown: 'Soft\nbreak  \nHard break',
    },
    {
      name: 'tables',
      markdown: '| Left | Right |\n| --- | --- |\n| A | B |\n| C | D |',
    },
  ])('matches native selection for $name rendered by Marked', ({ markdown }) => {
    const container = renderPlanMarkdown(markdown);
    selectAllRenderedText(container);

    expect(
      getPlanSelection(container, 'plan.md', getPlanSelectionTextRanges(container))?.selectedText,
    ).toBe(getNativeSelectionText());
  });

  it('excludes review-slot text from the selected prompt', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <p>Before plan text</p>
      <div data-plan-review-flow-slot><p>Review Goal Previous feedback</p></div>
      <p>After plan text</p>
    `;
    document.body.append(container);
    const paragraphs = container.querySelectorAll('p');
    selectText(paragraphs[0].firstChild as Text, paragraphs[2].firstChild as Text);

    const selectedText =
      getPlanSelection(container, 'plan.md', getPlanSelectionTextRanges(container))?.selectedText ??
      '';
    expect(selectedText).toContain('Before plan text');
    expect(selectedText).toContain('After plan text');
    expect(selectedText).not.toContain('Previous feedback');
  });

  it('does not return highlight ranges inside a review slot', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <p>Before plan text</p>
      <div data-plan-review-flow-slot><p>Review Goal Previous feedback</p></div>
      <p>After plan text</p>
    `;
    document.body.append(container);
    const paragraphs = container.querySelectorAll('p');
    selectText(paragraphs[0].firstChild as Text, paragraphs[2].firstChild as Text);

    const ranges = getPlanSelectionTextRanges(container);
    expect(ranges.map((range) => range.toString()).join('')).not.toContain('Previous feedback');
    expect(
      ranges.every(
        (range) =>
          range.commonAncestorContainer.parentElement?.closest(PLAN_REVIEW_FLOW_SLOT_SELECTOR) ===
          null,
      ),
    ).toBe(true);
  });

  it('keeps block indices and the flow anchor on real plan content', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <p>Before plan text</p>
      <div data-plan-review-flow-slot><p>Review Goal Previous feedback</p></div>
      <p>After plan text</p>
    `;
    document.body.append(container);
    const paragraphs = container.querySelectorAll('p');
    const range = document.createRange();
    range.setStart(paragraphs[0].firstChild as Text, 0);
    range.setEnd(paragraphs[2].firstChild as Text, (paragraphs[2].textContent ?? '').length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(
      getPlanSelection(container, 'plan.md', getPlanSelectionTextRanges(container)),
    ).toMatchObject({ startLine: 0, endLine: 1 });
    expect(getPlanSelectionFlowAnchor(container, getPlanSelectionTextRanges(container))).toBe(
      paragraphs[2],
    );
  });

  // innerText is stubbed here because happy-dom does not implement layout, so this cannot
  // assert real whitespace preservation. What it does assert is the reason whitespace
  // survives in a browser: the stub only returns code-block text when the offscreen host
  // contains `pre.shiki-block code`, so it fails unless cloneSelectionWithAncestors has
  // rebuilt that ancestor chain and let `white-space: pre` apply. Real whitespace parity is
  // covered by the native corpus above.
  it('rebuilds the code-block ancestor chain on the offscreen host', () => {
    const container = document.createElement('div');
    container.className = 'plan-markdown plan-markdown-dialog';
    const pre = document.createElement('pre');
    pre.className = 'shiki-block';
    const code = document.createElement('code');
    for (const line of ['function a() {', '  return 1;', '}']) {
      const span = document.createElement('span');
      span.className = 'line';
      span.textContent = line;
      code.append(span);
    }
    pre.append(code);
    container.append(pre);
    document.body.append(container);
    selectText(firstTextNodeIn(code), lastTextNodeIn(code));

    const originalInnerText = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText');
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() {
        return this.querySelector('pre.shiki-block code')
          ? 'function a() {\n  return 1;\n}'
          : (this.textContent ?? '');
      },
    });
    try {
      expect(
        getPlanSelection(container, 'plan.md', getPlanSelectionTextRanges(container))?.selectedText,
      ).toBe('function a() {\n  return 1;\n}');
    } finally {
      if (originalInnerText) {
        Object.defineProperty(HTMLElement.prototype, 'innerText', originalInnerText);
      } else {
        delete (HTMLElement.prototype as { innerText?: unknown }).innerText;
      }
    }
  });

  it('anchors a selection ending at the next block boundary to the prior block', () => {
    const container = renderPlanMarkdown('First paragraph.\n\nSecond paragraph.');
    const paragraphs = container.querySelectorAll('p');
    const range = document.createRange();
    range.setStart(paragraphs[0].firstChild as Text, 0);
    range.setEnd(paragraphs[1], 0);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(getPlanSelectionFlowAnchor(container, getPlanSelectionTextRanges(container))).toBe(
      paragraphs[0],
    );
    expect(
      getPlanSelection(container, 'plan.md', getPlanSelectionTextRanges(container)),
    ).toMatchObject({ startLine: 0, endLine: 0 });
    expect(getPlanSelectionTextRanges(container).map((item) => item.toString())).toEqual([
      'First paragraph.',
    ]);
  });

  it('preserves rendered block breaks between selected code and prose', () => {
    const container = renderPlanMarkdown('```ts\nconst x = 1;\n```\n\nAfter step');
    const codeText = firstTextNodeIn(container.querySelector('code') as HTMLElement);
    const proseText = container.querySelector('p')?.firstChild as Text;
    selectText(codeText, proseText);

    expect(
      getPlanSelection(container, 'plan.md', getPlanSelectionTextRanges(container))?.selectedText,
    ).toBe('const x = 1;\nAfter step');
  });

  it('intentionally excludes non-rendered Mermaid SVG text from prompt text', () => {
    const container = document.createElement('div');
    container.innerHTML = '<div class="mermaid-block"></div><p>After diagram</p>';
    const mermaid = container.querySelector('.mermaid-block') as HTMLDivElement;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const hidden = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    hidden.textContent = 'Hidden marker';
    const visible = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    visible.textContent = 'Visible diagram label';
    defs.append(hidden);
    svg.append(defs, visible);
    mermaid.append(svg);
    document.body.append(container);

    selectText(
      findTextNode(container, 'Hidden marker'),
      container.querySelector('p')?.firstChild as Text,
    );

    const selectedText =
      getPlanSelection(container, 'plan.md', getPlanSelectionTextRanges(container))?.selectedText ??
      '';
    expect(selectedText).not.toContain('Hidden marker');
    expect(selectedText).toContain('After diagram');
  });

  // Both helpers now take the ranges the caller already walked, so the contract is that the
  // ranges — not the live selection — decide whether there is anything to anchor.
  it('returns null when given no text ranges, even with a live selection', () => {
    const container = renderPlanMarkdown('First paragraph.\n\nSecond paragraph.');
    selectAllRenderedText(container);
    expect(getNativeSelectionText()).not.toBe('');

    expect(getPlanSelection(container, 'plan.md', [])).toBeNull();
    expect(getPlanSelectionFlowAnchor(container, [])).toBeNull();
  });

  it('resolves the flow anchor from ranges after the selection is cleared', () => {
    const container = renderPlanMarkdown('First paragraph.\n\nSecond paragraph.');
    const paragraphs = container.querySelectorAll('p');
    selectText(paragraphs[0].firstChild as Text, paragraphs[0].firstChild as Text);
    const textRanges = getPlanSelectionTextRanges(container);
    expect(textRanges).not.toHaveLength(0);

    // PlanViewerDialog clears the native selection right after computing these ranges.
    window.getSelection()?.removeAllRanges();

    expect(getPlanSelectionFlowAnchor(container, textRanges)).toBe(paragraphs[0]);
    expect(getPlanSelection(container, 'plan.md', textRanges)).toBeNull();
  });

  it('recalculates retained range geometry when the plan reflows', () => {
    const container = document.createElement('div');
    container.innerHTML = '<p>First block</p><p>Second block</p>';
    document.body.append(container);
    const paragraphs = container.querySelectorAll('p');
    selectText(paragraphs[0].firstChild as Text, paragraphs[1].firstChild as Text);
    const ranges = getPlanSelectionTextRanges(container);
    let rangeTops = [30, 110];
    ranges.forEach((range, index) => {
      Object.defineProperty(range, 'getClientRects', {
        value: () => [rect(rangeTops[index], 15)] as unknown as DOMRectList,
      });
    });
    Object.defineProperty(container, 'getBoundingClientRect', { value: () => rect(10, 5) });

    class FakeResizeObserver {
      static callback: ResizeObserverCallback;
      static disconnected = false;
      constructor(callback: ResizeObserverCallback) {
        FakeResizeObserver.callback = callback;
      }
      observe() {}
      disconnect() {
        FakeResizeObserver.disconnected = true;
      }
      static trigger() {
        FakeResizeObserver.callback([], {} as ResizeObserver);
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);

    const updates: number[][] = [];
    const stop = trackPlanSelectionGeometry(container, ranges, (next) =>
      updates.push(next.map((item) => item.top)),
    );
    expect(updates.at(-1)).toEqual([20, 100]);
    rangeTops = [30, 50];
    FakeResizeObserver.trigger();
    expect(updates.at(-1)).toEqual([20, 40]);
    stop();
    expect(FakeResizeObserver.disconnected).toBe(true);
  });
});
