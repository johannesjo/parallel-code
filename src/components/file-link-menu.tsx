import { DocumentIcon } from './icons';
import { IPC } from '../../electron/ipc/channels';
import { isExecutablePath } from '../../electron/shared/executable-path';
import { editAsDocument } from '../documents/store';

import { isMarkdownPath } from '../lib/canvas-tabs';
import { invoke } from '../lib/ipc';
import { errMessage } from '../lib/log';
import { isMac } from '../lib/platform';
import { openFileInEditor, openInEditor, revealItemInDir } from '../lib/shell';
import { showNotification, store } from '../store/store';
import {
  CopyIcon,
  DiffIcon,
  ExternalLinkIcon,
  EyeIcon,
  FolderIcon,
  LayersIcon,
  PencilIcon,
} from './icons';
import type { TerminalLinkAction } from './TerminalSelectionMenu';

/** What a clicked terminal link offers: menu entries, and what Cmd/Ctrl+click does. */
export interface FileLinkMenu {
  actions: TerminalLinkAction[];
  /** Absent when the file has nowhere to open without asking, such as a script with no editor. */
  open?: () => void;
}

/** The task's changed files; worktree-relative paths, as the changes list shows them. */
export interface ChangesLink {
  has: (relativePath: string) => boolean;
  open: (relativePath: string) => void;
}

export interface FileLinkContext {
  worktreePath: string;
  openDialog: (filePath: string) => void;
  /** Where Cmd/Ctrl+click sends Markdown when that isn't always the dialog. */
  openMarkdown?: (filePath: string) => void;
  /** Present where the task shows a side panel; takes a worktree-relative path. */
  openInSidePanel?: (relativePath: string) => void;
  /** Present where the task has a changes dialog; a listed file opens there by default. */
  changes?: ChangesLink;
}

/** Each kind of file decides which places a link can open it in. */
export type FileLinkKind = 'folder' | 'markdown' | 'html' | 'binary' | 'executable' | 'text';

// shortcut: known extensions only — unknown binaries count as text and go to the editor
const BINARY_RE =
  /\.(png|jpe?g|gif|webp|bmp|ico|svg|pdf|zip|tar|gz|tgz|7z|mp3|mp4|mov|wav|webm|woff2?|ttf|otf|sqlite|db)$/i;

// shortcut: only a trailing slash marks a folder — a stat over IPC would catch the rest
export function fileLinkKind(filePath: string): FileLinkKind {
  if (filePath.endsWith('/')) return 'folder';
  if (isMarkdownPath(filePath)) return 'markdown';
  if (/\.html?$/i.test(filePath)) return 'html';
  // The default app would run these, so they only open in the editor.
  if (isExecutablePath(filePath)) return 'executable';
  return BINARY_RE.test(filePath) ? 'binary' : 'text';
}

/** The worktree-relative path the side panel and line jumps need, or undefined outside it. */
export function worktreeRelativePath(worktreePath: string, filePath: string): string | undefined {
  if (!filePath.startsWith(`${worktreePath}/`)) return undefined;
  const relative = filePath.slice(worktreePath.length + 1).replace(/^(\.\/)+/, '');
  return relative && !relative.split('/').includes('..') ? relative : undefined;
}

function notifyOnFailure(filePath: string, opening: Promise<unknown>): void {
  opening.catch((err: unknown) =>
    showNotification(`Could not open ${filePath}: ${errMessage(err)}`),
  );
}

function openWithDefaultApp(filePath: string): void {
  // shell.openPath reports failure as a returned message, not a rejection.
  const opening = invoke<string>(IPC.OpenPath, { filePath }).then((message) => {
    if (message) throw new Error(message);
  });
  notifyOnFailure(filePath, opening);
}

/** Main expands ~/ for every channel; the renderer can't resolve other relative paths. */
const isOpenablePath = (filePath: string) => /^~?\//.test(filePath);

/** Only the line-jump channel knows the editor's line syntax, and it takes worktree files. */
function openWithEditor(
  filePath: string,
  line: number | undefined,
  { editorCommand, worktreePath }: { editorCommand: string; worktreePath: string },
): void {
  const relative = worktreeRelativePath(worktreePath, filePath);
  if (line && relative)
    notifyOnFailure(filePath, openFileInEditor(worktreePath, relative, { line, editorCommand }));
  else notifyOnFailure(filePath, openInEditor(editorCommand, filePath));
}

function copyPath(filePath: string): void {
  navigator.clipboard
    .writeText(filePath)
    .then(() => showNotification('Path copied to clipboard'))
    .catch((err: unknown) => showNotification(`Could not copy the path: ${errMessage(err)}`));
}

function copyMarkdown(filePath: string): void {
  invoke<string>(IPC.ReadFileText, { filePath })
    .then((text) => navigator.clipboard.writeText(text))
    .then(() => showNotification('Markdown copied to clipboard'))
    .catch((err: unknown) => showNotification(`Could not copy the Markdown: ${errMessage(err)}`));
}

const shortcut = `${isMac ? 'Cmd' : 'Ctrl'}+click`;

/** Opens a file the task changed in the changes dialog, or undefined when it isn't listed. */
function changesOpener(filePath: string, ctx: FileLinkContext): (() => void) | undefined {
  const changes = ctx.changes;
  const relative = worktreeRelativePath(ctx.worktreePath, filePath);
  if (!changes || !relative || !changes.has(relative)) return undefined;
  return () => changes.open(relative);
}

function markdownActions(
  filePath: string,
  ctx: FileLinkContext,
  isShortcut: boolean,
): TerminalLinkAction[] {
  const relative = worktreeRelativePath(ctx.worktreePath, filePath);
  const sidePanel = ctx.openInSidePanel;
  const openMarkdown = ctx.openMarkdown;
  // The lead entry is what Cmd/Ctrl+click does: the routed opener where there is one.
  return [
    ...(openMarkdown
      ? [
          {
            label: 'Open',
            title: isShortcut
              ? `What ${shortcut} does: the workspace for its files, else the dialog`
              : undefined,
            icon: () => <EyeIcon size={14} />,
            run: () => openMarkdown(filePath),
          },
        ]
      : []),
    {
      label: 'Open in dialog',
      title: ctx.openMarkdown || !isShortcut ? undefined : `${shortcut} opens the dialog directly`,
      icon: () => <EyeIcon size={14} />,
      run: () => ctx.openDialog(filePath),
    },
    ...(sidePanel && relative
      ? [
          {
            label: 'Open in side panel',
            icon: () => <LayersIcon size={14} />,
            run: () => sidePanel(relative),
          },
        ]
      : []),
  ];
}

function editAsDocumentActions(filePath: string): TerminalLinkAction[] {
  if (!store.documentWorkspacesEnabled) return [];
  return [
    {
      label: 'Edit as document',
      title: `Edit ${filePath} as a document (nothing is committed here)`,
      icon: () => <DocumentIcon size={14} />,
      run: () => editAsDocument(filePath),
    },
  ];
}

/** Every place a file an agent printed can open, offered when its link is clicked. */
export function fileLinkMenu(
  filePath: string,
  line: number | undefined,
  ctx: FileLinkContext,
): FileLinkMenu {
  const kind = fileLinkKind(filePath);
  const openable = isOpenablePath(filePath);
  const editorCommand = store.editorCommand;
  const reveal = () => notifyOnFailure(filePath, revealItemInDir(filePath));
  const defaultApp = () => openWithDefaultApp(filePath);
  // Without an editor, "the editor" is the default app — which would run a script.
  const editor =
    editorCommand && openable
      ? () => openWithEditor(filePath, line, { editorCommand, worktreePath: ctx.worktreePath })
      : kind === 'executable'
        ? undefined
        : defaultApp;
  const openChanges = kind === 'folder' ? undefined : changesOpener(filePath, ctx);
  const open =
    openChanges ??
    {
      folder: defaultApp,
      markdown: () => (ctx.openMarkdown ?? ctx.openDialog)(filePath),
      html: defaultApp,
      binary: defaultApp,
      executable: editor,
      text: editor,
    }[kind];
  const defaultAppItem = {
    label: kind === 'html' ? 'Open in browser' : 'Open with default app',
    icon: () => <ExternalLinkIcon size={14} />,
    run: defaultApp,
  };
  const editorItems = !editor
    ? []
    : editor === defaultApp
      ? [{ ...defaultAppItem, label: 'Open with default app' }]
      : [{ label: 'Open in editor', icon: () => <PencilIcon size={14} />, run: editor }];
  const primary = {
    folder: [{ label: 'Open folder', icon: () => <FolderIcon size={14} />, run: defaultApp }],
    markdown: [
      // A changed file's Cmd/Ctrl+click goes to the changes dialog instead.
      ...markdownActions(filePath, ctx, !openChanges),
      ...editAsDocumentActions(filePath),
      ...editorItems,
    ],
    // Without an editor its entry would repeat "Open in browser".
    html: [
      defaultAppItem,
      ...editAsDocumentActions(filePath),
      ...(editor === defaultApp ? [] : editorItems),
    ],
    binary: [defaultAppItem],
    executable: editorItems,
    text: editorItems,
  }[kind];
  const revealItems = openable
    ? [{ label: 'Show in folder', icon: () => <FolderIcon size={14} />, run: reveal }]
    : [];
  const changesItems = openChanges
    ? [
        {
          label: 'Open in changes',
          title: `What ${shortcut} does: this file's diff in the changes dialog`,
          icon: () => <DiffIcon size={14} />,
          run: openChanges,
        },
      ]
    : [];
  return {
    actions: [
      ...changesItems,
      ...primary,
      ...revealItems,
      ...(kind === 'markdown'
        ? [
            {
              label: 'Copy Markdown',
              icon: () => <CopyIcon size={14} />,
              run: () => copyMarkdown(filePath),
            },
          ]
        : []),
      { label: 'Copy path', icon: () => <CopyIcon size={14} />, run: () => copyPath(filePath) },
    ],
    open,
  };
}
