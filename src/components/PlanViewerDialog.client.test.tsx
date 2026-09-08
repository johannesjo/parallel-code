import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanViewerDialog } from './PlanViewerDialog';

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function waitForElement<T extends Element>(selector: string): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const element = document.querySelector<T>(selector);
    if (element) return element;
    await Promise.resolve();
  }
  throw new Error(`Element did not render: ${selector}`);
}

function selectText(text: Text): void {
  const range = document.createRange();
  range.selectNodeContents(text);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe('PlanViewerDialog inline review flow', () => {
  it('keeps the inline slot connected when a selection becomes a comment', async () => {
    const rangeRects = vi
      .spyOn(Range.prototype, 'getClientRects')
      .mockReturnValue([] as unknown as DOMRectList);
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(
        () => (
          <PlanViewerDialog
            open
            onClose={() => undefined}
            planContent={'# Plan\n\nFirst paragraph.\n\nSecond paragraph.'}
            planFileName="plan.md"
            taskId="task-a"
            agentId="agent-a"
            worktreePath="/worktree-a"
          />
        ),
        host,
      ),
    );

    const paragraph = await waitForElement<HTMLParagraphElement>('.plan-markdown p');
    selectText(paragraph.firstChild as Text);
    paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    const slot = document.querySelector<HTMLDivElement>('[data-plan-review-flow-slot]');
    expect(slot?.isConnected).toBe(true);
    const input = slot?.querySelector<HTMLInputElement>('input');
    expect(input).not.toBeNull();
    if (!input) throw new Error('Inline review input did not render');

    input.value = 'Keep this behavior.';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    const annotation = document.querySelector<HTMLElement>('.plan-markdown [data-annotation-id]');
    expect(annotation).not.toBeNull();
    expect(annotation?.closest('[data-plan-review-flow-slot]')?.isConnected).toBe(true);
    expect(annotation?.textContent).toContain('Keep this behavior.');
    expect(rangeRects).toHaveBeenCalled();
  });

  // handleMouseUp now walks the selection once and hands the ranges to both helpers. That
  // sharing is only safe if the walk still excludes flow-slot UI, so drive a selection that
  // spans a card already in the document.
  it('excludes an existing card from a selection drawn across it', async () => {
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([] as unknown as DOMRectList);
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(
        () => (
          <PlanViewerDialog
            open
            onClose={() => undefined}
            planContent={'# Plan\n\nFirst paragraph.\n\nSecond paragraph.'}
            planFileName="plan.md"
            taskId="task-a"
            agentId="agent-a"
            worktreePath="/worktree-a"
          />
        ),
        host,
      ),
    );

    await waitForElement('.plan-markdown p');
    const paragraphs = document.querySelectorAll<HTMLParagraphElement>('.plan-markdown p');
    selectText(paragraphs[0].firstChild as Text);
    paragraphs[0].dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const firstInput = document.querySelector<HTMLInputElement>(
      '[data-plan-review-flow-slot] input',
    );
    if (!firstInput) throw new Error('Inline review input did not render');
    firstInput.value = 'CARD_TEXT_MARKER';
    firstInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
    firstInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    const card = document.querySelector('[data-plan-review-flow-slot]');
    expect(card?.textContent).toContain('CARD_TEXT_MARKER');

    // Select from before the card to after it, so the range crosses the rendered card.
    const range = document.createRange();
    range.setStart(paragraphs[0].firstChild as Text, 0);
    range.setEnd(paragraphs[1].firstChild as Text, (paragraphs[1].textContent ?? '').length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(selection?.toString()).toContain('CARD_TEXT_MARKER');
    paragraphs[1].dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    const pendingSlot = document.querySelector('[data-plan-review-flow-slot] input');
    expect(pendingSlot).not.toBeNull();

    const secondInput = document.querySelectorAll<HTMLInputElement>(
      '[data-plan-review-flow-slot] input',
    )[0];
    secondInput.value = 'second comment';
    secondInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
    secondInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    const annotations = document.querySelectorAll('.plan-markdown [data-annotation-id]');
    expect(annotations).toHaveLength(2);
    // The sidebar quotes each annotation's stored selectedText. The two paragraphs must be
    // adjacent there: the card sits between them in the document, so if flow-slot exclusion
    // broke, its text would appear inside the quote.
    expect(document.body.textContent).toContain('First paragraph.\nSecond paragraph.');
  });
});
