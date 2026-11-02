import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  store: { editorCommand: '', documentWorkspacesEnabled: false },
  showNotification: vi.fn(),
  editAsDocument: vi.fn(),
  openFileInEditor: vi.fn(),
  openInEditor: vi.fn(),
  revealItemInDir: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock('../store/store', () => ({ store: mocks.store, showNotification: mocks.showNotification }));
vi.mock('../documents/store', () => ({ editAsDocument: mocks.editAsDocument }));
vi.mock('../lib/shell', () => ({
  openFileInEditor: mocks.openFileInEditor,
  openInEditor: mocks.openInEditor,
  revealItemInDir: mocks.revealItemInDir,
}));
vi.mock('../lib/ipc', () => ({ invoke: mocks.invoke }));

import { IPC } from '../../electron/ipc/channels';
import { fileLinkKind, fileLinkMenu, worktreeRelativePath } from './file-link-menu';

const worktreePath = '/repo/wt';
function context() {
  return { worktreePath, openDialog: vi.fn(), openInSidePanel: vi.fn() };
}
function labels(filePath: string, line?: number) {
  return fileLinkMenu(filePath, line, context()).actions.map((a) => a.label);
}
function run(menu: ReturnType<typeof fileLinkMenu>, label: string) {
  const found = menu.actions.find((a) => a.label === label);
  if (!found) throw new Error(`Missing ${label}`);
  found.run();
}

beforeEach(() => {
  mocks.store.editorCommand = '';
  mocks.store.documentWorkspacesEnabled = false;
  for (const fn of [mocks.openFileInEditor, mocks.openInEditor, mocks.revealItemInDir])
    fn.mockResolvedValue(undefined);
  mocks.invoke.mockResolvedValue('');
});
afterEach(() => vi.clearAllMocks());

it('sorts paths into the kinds that decide their destinations', () => {
  expect(fileLinkKind('a/README.markdown')).toBe('markdown');
  expect(fileLinkKind('a/index.HTM')).toBe('html');
  expect(fileLinkKind('a/shot.png')).toBe('binary');
  expect(fileLinkKind('a/build.sh')).toBe('executable');
  expect(fileLinkKind('a/main.ts')).toBe('text');
});

it('resolves only paths inside the worktree', () => {
  expect(worktreeRelativePath(worktreePath, '/repo/wt/./docs/plan.md')).toBe('docs/plan.md');
  expect(worktreeRelativePath(worktreePath, '/repo/wt/../other/plan.md')).toBeUndefined();
  expect(worktreeRelativePath(worktreePath, '/repo/wt-other/plan.md')).toBeUndefined();
  expect(worktreeRelativePath(worktreePath, '~/notes.md')).toBeUndefined();
});

it('offers every Markdown destination for a worktree file', () => {
  mocks.store.documentWorkspacesEnabled = true;
  mocks.store.editorCommand = 'code';
  const ctx = context();
  const menu = fileLinkMenu('/repo/wt/docs/plan.md', undefined, ctx);
  expect(menu.actions.map((a) => a.label)).toEqual([
    'Open in dialog',
    'Open in side panel',
    'Edit as document',
    'Open in editor',
    'Show in folder',
    'Copy Markdown',
    'Copy path',
  ]);
  run(menu, 'Open in side panel');
  expect(ctx.openInSidePanel).toHaveBeenCalledWith('docs/plan.md');
  run(menu, 'Open in dialog');
  expect(ctx.openDialog).toHaveBeenCalledWith('/repo/wt/docs/plan.md');
  run(menu, 'Edit as document');
  expect(mocks.editAsDocument).toHaveBeenCalledWith('/repo/wt/docs/plan.md');
  menu.open?.();
  expect(ctx.openDialog).toHaveBeenLastCalledWith('/repo/wt/docs/plan.md');
  expect(menu.actions.find((a) => a.label === 'Open in dialog')?.title).toMatch(
    /\+click opens the dialog directly/,
  );
});

it('leads every menu with what Cmd/Ctrl+click does', () => {
  mocks.store.documentWorkspacesEnabled = true;
  const paths = [
    '/repo/wt/a.md',
    '/repo/wt/a.html',
    '/repo/wt/a.png',
    '/repo/wt/a.ts',
    '/repo/wt/d/',
  ];
  for (const editorCommand of ['', 'code'])
    for (const routed of [false, true])
      for (const filePath of paths) {
        mocks.store.editorCommand = editorCommand;
        const ctx = { ...context(), openMarkdown: routed ? vi.fn() : undefined };
        const calls = () => [
          ...mocks.invoke.mock.calls,
          ...mocks.openFileInEditor.mock.calls,
          ...mocks.openInEditor.mock.calls,
          ...ctx.openDialog.mock.calls,
          ...(ctx.openMarkdown?.mock.calls ?? []),
        ];
        const menu = fileLinkMenu(filePath, 3, ctx);
        menu.actions[0]?.run();
        const first = calls();
        vi.clearAllMocks();
        menu.open?.();
        expect(calls(), `${filePath}, editor "${editorCommand}", routed ${routed}`).toEqual(first);
        expect(first).not.toEqual([]);
        vi.clearAllMocks();
      }
});

it('sends Markdown where the terminal routes it, without promising the dialog', () => {
  const ctx = { ...context(), openMarkdown: vi.fn() };
  const menu = fileLinkMenu('/repo/wt/docs/plan.md', undefined, ctx);
  menu.open?.();
  expect(ctx.openMarkdown).toHaveBeenCalledWith('/repo/wt/docs/plan.md');
  expect(ctx.openDialog).not.toHaveBeenCalled();
  expect(menu.actions.find((a) => a.label === 'Open in dialog')?.title).toBeUndefined();
});

it('leaves out destinations a path or the app cannot use', () => {
  mocks.store.editorCommand = 'code';
  expect(labels('/elsewhere/plan.md')).toEqual([
    'Open in dialog',
    'Open in editor',
    'Show in folder',
    'Copy Markdown',
    'Copy path',
  ]);
});

it('opens home-relative paths everywhere, leaving ~ for main to expand', () => {
  mocks.store.editorCommand = 'code';
  const menu = fileLinkMenu('~/notes/plan.md', undefined, context());
  expect(menu.actions.map((a) => a.label)).toEqual([
    'Open in dialog',
    'Open in editor',
    'Show in folder',
    'Copy Markdown',
    'Copy path',
  ]);
  run(menu, 'Open in editor');
  expect(mocks.openInEditor).toHaveBeenCalledWith('code', '~/notes/plan.md');
  run(menu, 'Show in folder');
  expect(mocks.revealItemInDir).toHaveBeenCalledWith('~/notes/plan.md');
});

it('offers the right entries for each other kind', () => {
  mocks.store.documentWorkspacesEnabled = true;
  mocks.store.editorCommand = 'code';
  expect(labels('/repo/wt/index.html')).toEqual([
    'Open in browser',
    'Edit as document',
    'Open in editor',
    'Show in folder',
    'Copy path',
  ]);
  expect(labels('/repo/wt/main.ts', 4)).toEqual(['Open in editor', 'Show in folder', 'Copy path']);
  expect(labels('/repo/wt/shot.png')).toEqual([
    'Open with default app',
    'Show in folder',
    'Copy path',
  ]);
  expect(labels('/repo/wt/build.sh')).toEqual(['Open in editor', 'Show in folder', 'Copy path']);
});

it('opens code in the editor at the cited line inside the worktree', () => {
  mocks.store.editorCommand = 'code';
  fileLinkMenu('/repo/wt/src/main.ts', 42, context()).open?.();
  expect(mocks.openFileInEditor).toHaveBeenCalledWith(worktreePath, 'src/main.ts', {
    line: 42,
    editorCommand: 'code',
  });
  fileLinkMenu('/elsewhere/main.ts', 42, context()).open?.();
  expect(mocks.openInEditor).toHaveBeenCalledWith('code', '/elsewhere/main.ts');
});

it('falls back to the default app without an editor command', () => {
  fileLinkMenu('/repo/wt/src/main.ts', 42, context()).open?.();
  expect(mocks.invoke).toHaveBeenCalledWith(IPC.OpenPath, { filePath: '/repo/wt/src/main.ts' });
  expect(mocks.openFileInEditor).not.toHaveBeenCalled();
});

it('opens HTML and binaries with the default app, never scripts', () => {
  mocks.store.editorCommand = 'code';
  fileLinkMenu('/repo/wt/index.html', undefined, context()).open?.();
  fileLinkMenu('/repo/wt/shot.png', undefined, context()).open?.();
  expect(mocks.invoke.mock.calls).toEqual([
    [IPC.OpenPath, { filePath: '/repo/wt/index.html' }],
    [IPC.OpenPath, { filePath: '/repo/wt/shot.png' }],
  ]);
  fileLinkMenu('/repo/wt/build.sh', undefined, context()).open?.();
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
  expect(mocks.openInEditor).toHaveBeenCalledWith('code', '/repo/wt/build.sh');
});

it('reports a failed open', async () => {
  mocks.invoke.mockRejectedValue(new Error('No app'));
  fileLinkMenu('/repo/wt/shot.png', undefined, context()).open?.();
  await vi.waitFor(() =>
    expect(mocks.showNotification).toHaveBeenCalledWith('Could not open /repo/wt/shot.png: No app'),
  );
});

it('reveals and copies the resolved path', async () => {
  const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  const menu = fileLinkMenu('/repo/wt/a.ts', 3, context());
  run(menu, 'Show in folder');
  expect(mocks.revealItemInDir).toHaveBeenCalledWith('/repo/wt/a.ts');
  run(menu, 'Copy path');
  expect(write).toHaveBeenCalledWith('/repo/wt/a.ts');
  await vi.waitFor(() =>
    expect(mocks.showNotification).toHaveBeenCalledWith('Path copied to clipboard'),
  );
});

it('copies the raw Markdown of the clicked file', async () => {
  const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  mocks.invoke.mockResolvedValue('# Plan\n');
  run(fileLinkMenu('/repo/wt/docs/plan.md', undefined, context()), 'Copy Markdown');
  await vi.waitFor(() =>
    expect(mocks.showNotification).toHaveBeenCalledWith('Markdown copied to clipboard'),
  );
  expect(mocks.invoke).toHaveBeenCalledWith(IPC.ReadFileText, {
    filePath: '/repo/wt/docs/plan.md',
  });
  expect(write).toHaveBeenCalledWith('# Plan\n');
});

it('reports why copying the Markdown failed', async () => {
  const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  mocks.invoke.mockRejectedValue(new Error('ENOENT'));
  run(fileLinkMenu('/repo/wt/gone.md', undefined, context()), 'Copy Markdown');
  await vi.waitFor(() =>
    expect(mocks.showNotification).toHaveBeenCalledWith('Could not copy the Markdown: ENOENT'),
  );
  expect(write).not.toHaveBeenCalled();
});

it('offers Markdown copying only for Markdown files', () => {
  for (const filePath of ['/repo/wt/a.html', '/repo/wt/a.ts', '/repo/wt/a.png', '/repo/wt/d/'])
    expect(labels(filePath)).not.toContain('Copy Markdown');
});

it('treats .markdown like .md', () => {
  const ctx = context();
  const menu = fileLinkMenu('/repo/wt/notes.markdown', undefined, ctx);
  expect(menu.actions.map((a) => a.label)).toContain('Open in side panel');
  menu.open?.();
  expect(ctx.openDialog).toHaveBeenCalledWith('/repo/wt/notes.markdown');
});

it('names the default app when no editor is configured, and offers scripts none', () => {
  mocks.store.documentWorkspacesEnabled = true;
  expect(labels('/repo/wt/main.ts', 4)).toEqual([
    'Open with default app',
    'Show in folder',
    'Copy path',
  ]);
  expect(labels('/repo/wt/index.html')).toEqual([
    'Open in browser',
    'Edit as document',
    'Show in folder',
    'Copy path',
  ]);
  expect(labels('/repo/wt/build.sh', 12)).toEqual(['Show in folder', 'Copy path']);
  // Cmd/Ctrl+click then offers the menu rather than an error.
  expect(fileLinkMenu('/repo/wt/build.sh', 12, context()).open).toBeUndefined();
});

it('sends a script with a cited line to the editor, which main never hands to the default app', () => {
  mocks.store.editorCommand = 'vim';
  fileLinkMenu('/repo/wt/build.sh', 12, context()).open?.();
  expect(mocks.openFileInEditor).toHaveBeenCalledWith(worktreePath, 'build.sh', {
    line: 12,
    editorCommand: 'vim',
  });
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it('reports a default-app failure that main returns as a message', async () => {
  mocks.invoke.mockResolvedValue('No application knows how to open this file');
  fileLinkMenu('/repo/wt/shot.png', undefined, context()).open?.();
  await vi.waitFor(() =>
    expect(mocks.showNotification).toHaveBeenCalledWith(
      'Could not open /repo/wt/shot.png: No application knows how to open this file',
    ),
  );
});

it('offers a folder open, reveal or copy, and opens it on Cmd/Ctrl+click', () => {
  mocks.store.editorCommand = 'code';
  expect(fileLinkKind('/repo/wt/src.d/')).toBe('folder');
  const menu = fileLinkMenu('/repo/wt/src.d/', undefined, context());
  expect(menu.actions.map((a) => a.label)).toEqual(['Open folder', 'Show in folder', 'Copy path']);
  menu.open?.();
  expect(mocks.invoke).toHaveBeenCalledWith(IPC.OpenPath, { filePath: '/repo/wt/src.d/' });
  expect(mocks.openInEditor).not.toHaveBeenCalled();
});

it('leads with the changes dialog for a file the task changed, and opens it there', () => {
  mocks.store.editorCommand = 'code';
  const open = vi.fn();
  const ctx = {
    ...context(),
    changes: { has: (path: string) => ['src/main.ts', 'docs/plan.md'].includes(path), open },
  };
  for (const [filePath, relative] of [
    ['/repo/wt/src/main.ts', 'src/main.ts'],
    ['/repo/wt/docs/plan.md', 'docs/plan.md'],
  ]) {
    open.mockClear();
    const menu = fileLinkMenu(filePath, 3, ctx);
    expect(menu.actions[0]?.label).toBe('Open in changes');
    menu.open?.();
    run(menu, 'Open in changes');
    expect(open.mock.calls).toEqual([[relative], [relative]]);
  }
  expect(mocks.openFileInEditor).not.toHaveBeenCalled();
  expect(ctx.openDialog).not.toHaveBeenCalled();
});

it('keeps the usual menu for files the task did not change', () => {
  const ctx = { ...context(), changes: { has: () => false, open: vi.fn() } };
  expect(fileLinkMenu('/repo/wt/src/other.ts', undefined, ctx).actions[0]?.label).not.toBe(
    'Open in changes',
  );
  expect(fileLinkMenu('/outside/main.ts', undefined, ctx).actions[0]?.label).not.toBe(
    'Open in changes',
  );
  fileLinkMenu('/repo/wt/docs/plan.md', undefined, ctx).open?.();
  expect(ctx.openDialog).toHaveBeenCalledWith('/repo/wt/docs/plan.md');
});
