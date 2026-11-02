import { DocumentIcon, ExternalLinkIcon } from './icons';
import { Show, createSignal, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';

import { editAsDocument } from '../documents/store';
import { isEditableDocumentPath } from '../lib/document-path';
import { sf } from '../lib/fontScale';
import { invoke } from '../lib/ipc';
import { errMessage, warn as logWarn } from '../lib/log';
import { createHighlightedMarkdown } from '../lib/marked-shiki';
import { theme } from '../lib/theme';
import { store } from '../store/store';
import { Dialog } from './Dialog';
import { CheckIcon, CloseIcon, CopyIcon } from './icons';

/** A Markdown file a terminal link pointed at, shown in a dialog over the task. */
export interface MarkdownViewer {
  show: (filePath: string) => void;
  view: () => JSX.Element;
}

/** Owns the dialog's state, so any terminal of the task can open a file in it. */
export function createMarkdownViewer(): MarkdownViewer {
  const [content, setContent] = createSignal('');
  const [filePath, setFilePath] = createSignal('');
  const [open, setOpen] = createSignal(false);

  function showContent(path: string, text: string) {
    setContent(text);
    setFilePath(path);
    setOpen(true);
  }

  function show(path: string) {
    invoke<string>(IPC.ReadFileText, { filePath: path })
      .then((text) => showContent(path, text))
      .catch((err) => showContent(path, `**Error loading file:** ${String(err)}`));
  }

  return {
    show,
    view: () => (
      <MarkdownViewerDialog
        open={open()}
        onClose={() => setOpen(false)}
        content={content()}
        fileName={filePath().split('/').pop() ?? filePath()}
        filePath={filePath()}
        onEditAsDocument={store.documentWorkspacesEnabled ? editAsDocument : undefined}
      />
    ),
  };
}

function MarkdownViewerDialog(props: {
  open: boolean;
  onClose: () => void;
  content: string;
  fileName: string;
  filePath: string;
  onEditAsDocument?: (filePath: string) => void;
}) {
  const html = createHighlightedMarkdown(() => props.content);
  const [copied, setCopied] = createSignal(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(copiedTimer));

  function copyMarkdown() {
    navigator.clipboard
      .writeText(props.content)
      .then(() => {
        setCopied(true);
        clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => setCopied(false), 1500);
      })
      .catch((err: unknown) => {
        logWarn('clipboard', 'Could not copy Markdown', { err: errMessage(err) });
      });
  }

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      width="fit-content"
      panelStyle={{
        width: '80vw',
        'max-width': '1200px',
        height: '80vh',
        overflow: 'hidden',
        padding: '0',
        gap: '0',
        resize: 'both',
      }}
    >
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
          {props.fileName}
        </span>
        <span style={{ flex: '1' }} />
        <button
          onClick={copyMarkdown}
          style={{
            background: 'transparent',
            border: 'none',
            color: copied() ? theme.success : theme.fgMuted,
            cursor: 'pointer',
            padding: '4px',
            display: 'flex',
            'align-items': 'center',
            'border-radius': 'var(--radius-xs)',
          }}
          title={copied() ? 'Copied' : 'Copy Markdown'}
        >
          {copied() ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
        </button>
        <Show when={props.filePath}>
          <button
            onClick={() => {
              invoke(IPC.OpenPath, { filePath: props.filePath }).catch(console.error);
            }}
            style={{
              background: 'transparent',
              border: 'none',
              color: theme.fgMuted,
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
              'align-items': 'center',
              'border-radius': 'var(--radius-xs)',
            }}
            title="Open in editor"
          >
            <ExternalLinkIcon />
          </button>
        </Show>
        <Show when={props.onEditAsDocument && isEditableDocumentPath(props.filePath)}>
          <button
            onClick={() => {
              props.onEditAsDocument?.(props.filePath);
              props.onClose();
            }}
            style={{
              background: 'transparent',
              border: 'none',
              color: theme.fgMuted,
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
              'align-items': 'center',
              'border-radius': 'var(--radius-xs)',
            }}
            title={`Edit ${props.fileName} as a document (nothing is committed here)`}
            aria-label="Edit as document"
          >
            <DocumentIcon size={16} />
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
            'border-radius': 'var(--radius-xs)',
          }}
          title="Close"
        >
          <CloseIcon />
        </button>
      </div>
      <div
        style={{
          flex: '1',
          'overflow-y': 'auto',
          padding: '28px 40px',
        }}
      >
        <div
          class="plan-markdown plan-markdown-dialog"
          style={{ color: theme.fg, 'max-width': '100%' }}
          // eslint-disable-next-line solid/no-innerhtml -- local markdown files from worktree
          innerHTML={html()}
        />
      </div>
    </Dialog>
  );
}
