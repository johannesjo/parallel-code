import { EditorView } from '@codemirror/view';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlockEditor, type BlockEditTarget } from './BlockEditor';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.resetAllMocks();
});

const target: BlockEditTarget = {
  projectRoot: '/project',
  documentPath: 'plan.md',
  source: '# Plan\r\n\r\nTypo.\r\n',
  block: {
    index: 1,
    type: 'paragraph',
    raw: 'Typo.\n',
    html: '<p>Typo.</p>',
    startLine: 3,
    endLine: 3,
    startOffset: 8,
    endOffset: 13,
  },
};

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const onClose = vi.fn();
  const onSaved = vi.fn();
  dispose = render(() => <BlockEditor target={target} onClose={onClose} onSaved={onSaved} />, host);
  return { onClose, onSaved };
}

describe('BlockEditor', () => {
  it('reports a block that no longer matches the file instead of throwing', () => {
    const moved: BlockEditTarget = { ...target, source: '# Plan\r\n\r\nSomething else.\r\n' };
    const host = document.createElement('div');
    document.body.append(host);
    expect(() => {
      dispose = render(
        () => <BlockEditor target={moved} onClose={() => {}} onSaved={() => {}} />,
        host,
      );
    }).not.toThrow();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Select it again');
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.querySelector('.docws-btn-primary')).toBeNull();
  });

  it('saves just the selected range with the original newline convention', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const { onClose, onSaved } = mount();
    const input = document.querySelector('textarea') as HTMLTextAreaElement;
    const save = document.querySelector('.docws-btn-primary') as HTMLButtonElement;
    expect(input.value).toBe('Typo.');
    expect(save.disabled).toBe(true);
    input.value = 'Corrected.\nAnother line.';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    save.click();
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(onClose).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(IPC.WriteDocumentBlock, {
      projectRoot: '/project',
      documentPath: 'plan.md',
      expectedContent: target.source,
      startOffset: 10,
      endOffset: 15,
      replacement: 'Corrected.\r\nAnother line.',
    });
  });

  it('asks before an edit in progress is thrown away', async () => {
    const { onClose } = mount();
    const cancel = document.querySelector('.docws-run-actions .docws-btn') as HTMLButtonElement;
    const find = (label: string) =>
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
    cancel.click();
    expect(onClose).toHaveBeenCalledOnce();

    const input = document.querySelector('textarea') as HTMLTextAreaElement;
    input.value = 'Half done';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    cancel.click();
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain('Discard edits?');

    find('Keep editing')?.click();
    await vi.waitFor(() => expect(document.body.textContent).not.toContain('Discard edits?'));
    expect(onClose).toHaveBeenCalledOnce();
    expect(input.value).toBe('Half done');

    cancel.click();
    find('Discard')?.click();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('preserves the edit and stays open when the file has changed', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('The document changed.'));
    const { onClose, onSaved } = mount();
    const input = document.querySelector('textarea') as HTMLTextAreaElement;
    input.value = 'My correction';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('.docws-btn-primary') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toBe('The document changed.'),
    );
    expect(input.value).toBe('My correction');
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  describe('inline', () => {
    function mountInline() {
      const host = document.createElement('div');
      document.body.append(host);
      const onClose = vi.fn();
      dispose = render(
        () => <BlockEditor target={target} inline onClose={onClose} onSaved={() => {}} />,
        host,
      );
      const content = host.querySelector<HTMLElement>('.cm-content');
      const view = content && EditorView.findFromDOM(content);
      if (!content || !view) throw new Error('No live Markdown editor');
      const type = (text: string) =>
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      return { host, onClose, content, view, type };
    }

    it('edits in the page with the live Markdown editor rather than in a dialog', () => {
      const { host, view } = mountInline();
      expect(view.state.doc.toString()).toBe('Typo.');
      expect(host.querySelector('textarea')).toBeNull();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it('puts an untouched editor away on Escape or a press elsewhere', () => {
      const { onClose, content } = mountInline();
      content.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      expect(onClose).not.toHaveBeenCalled();
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      expect(onClose).toHaveBeenCalledOnce();
      content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('hands the field back for another try when saving fails', async () => {
      vi.mocked(invoke).mockRejectedValue(new Error('The document changed.'));
      const { host, content, type } = mountInline();
      type('Fixed.');
      content.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
      );
      await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
      expect(document.activeElement).toBe(content);
    });

    it('leaves the focus where the user put it while a failed save ran', async () => {
      let fail: (err: Error) => void = () => {};
      vi.mocked(invoke).mockImplementation(() => new Promise((_, reject) => (fail = reject)));
      const { host, content, type } = mountInline();
      const elsewhere = document.createElement('input');
      document.body.append(elsewhere);
      type('Fixed.');
      content.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
      );
      elsewhere.focus();
      fail(new Error('The document changed.'));
      await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
      expect(document.activeElement).toBe(elsewhere);
    });

    it('stays open while the page is scrolled from its scrollbar', () => {
      const { onClose } = mountInline();
      const page = document.createElement('div');
      document.body.append(page);
      for (const [key, value] of Object.entries({
        clientWidth: 300,
        scrollHeight: 900,
        clientHeight: 400,
      }))
        Object.defineProperty(page, key, { value });
      const press = new MouseEvent('mousedown', { bubbles: true });
      Object.defineProperty(press, 'offsetX', { value: 305 });
      page.dispatchEvent(press);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('keeps an edit in progress when the press lands elsewhere', () => {
      const { onClose, view, type } = mountInline();
      type('Half done');
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      expect(onClose).not.toHaveBeenCalled();
      expect(view.state.doc.toString()).toBe('Half done');
    });

    it('saves what was typed on Ctrl+Enter, without the editor adding a line', async () => {
      vi.mocked(invoke).mockResolvedValue(undefined);
      const { host, onClose, content, type } = mountInline();
      type('Fixed.\nNext.');
      content.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
      );
      // Typing on while it saves would be closed away unsaved.
      expect(host.querySelector('.docws-block-editor')?.hasAttribute('inert')).toBe(true);
      await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
      expect(invoke).toHaveBeenCalledWith(
        IPC.WriteDocumentBlock,
        expect.objectContaining({ replacement: 'Fixed.\r\nNext.' }),
      );
    });
  });
});
