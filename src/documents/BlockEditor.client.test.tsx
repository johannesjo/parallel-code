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
});
