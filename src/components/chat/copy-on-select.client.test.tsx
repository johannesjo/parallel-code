import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableCopyOnSelect } from './copy-on-select';

let root: HTMLDivElement;
let message: HTMLParagraphElement;
let composer: HTMLTextAreaElement;
let stop: () => void;
const writeText = vi.fn(async () => undefined);
let selected = '';
let anchor: Node | null = null;

/** happy-dom has no selection model, so drive the text the document reports directly. */
function select(text: string, from: Node | null = message) {
  selected = text;
  anchor = from;
}
function mouseUpOn(node: Element) {
  node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
}

beforeEach(() => {
  selected = '';
  writeText.mockClear();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  root = document.createElement('div');
  document.body.append(root);
  vi.spyOn(document, 'getSelection').mockImplementation(
    () => ({ anchorNode: anchor, toString: () => selected }) as Selection,
  );
  message = document.createElement('p');
  message.textContent = 'Hello';
  composer = document.createElement('textarea');
  root.append(message, composer);
  stop = enableCopyOnSelect(root);
});
afterEach(() => {
  stop();
  root.remove();
  vi.restoreAllMocks();
});

describe('copy on select', () => {
  it('copies a finished selection from the log', () => {
    select('npm run check');
    mouseUpOn(message);
    expect(writeText).toHaveBeenCalledWith('npm run check');
  });

  it('ignores a click that selected nothing', () => {
    select('   ');
    mouseUpOn(message);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('leaves the clipboard alone while selecting inside the composer', () => {
    select('half-written message');
    mouseUpOn(composer);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('leaves a selection made elsewhere in the app alone', () => {
    const outside = document.createElement('p');
    document.body.append(outside);
    select('terminal text', outside);
    mouseUpOn(message);
    expect(writeText).not.toHaveBeenCalled();
    outside.remove();
  });

  it('stops listening once disposed', () => {
    stop();
    select('npm run check');
    mouseUpOn(message);
    expect(writeText).not.toHaveBeenCalled();
  });
});
