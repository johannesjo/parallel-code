import type { MenuItemConstructorOptions } from 'electron';

export interface MenuTemplateOptions {
  platform: NodeJS.Platform;
  appName: string;
  onQuit: () => void;
}

// Electron installs a default menu when none is set, and macOS dispatches native
// menu key equivalents *before* the web contents sees the keydown — so on macOS
// every accelerator that menu registers is a shortcut the renderer can never
// receive. Three default roles claim keys this app binds itself: `fileMenu`
// takes Cmd+W (close the focused shell/terminal), `viewMenu` takes Cmd+0 / Cmd+±
// (the app scales its whole UI through globalScale instead of Chromium's zoom),
// and `appMenu` takes Cmd+Q (the renderer turns it into a hold, see below).
// Spelling those submenus out on macOS keeps their items reachable by mouse
// while leaving the keys to the renderer; Cmd+W stays unbound there on purpose,
// so it does nothing when no pane is focused rather than closing the window out
// from under a terminal.
//
// Linux inverts that ordering — the renderer sees keys first and only unhandled
// ones fall through to the menu — so the stock roles are harmless there and the
// Linux template keeps them, zoom and Ctrl+W included. It needs a template at
// all for one reason: the default `viewMenu` role binds Ctrl+R / Ctrl+Shift+R,
// and reload must not be bound anywhere. (`setApplicationMenu(null)` would kill
// every Linux accelerator in one line, but it also kills Ctrl+Q, and
// hold-to-quit is macOS-only — see src/lib/hold-to-quit.ts — so Linux would lose
// its only keyboard quit.) Note the Linux window is frameless, so this menu is
// never drawn; there it is an accelerator table and nothing more.
//
// Reload has no item and no accelerator on either platform. A reload throws away
// every pane's UI state, which is not something to hang off one mistyped
// keystroke in a terminal app. On macOS that also hands Cmd+R back to the
// DevTools front-end's own reload-the-inspected-page binding, which the native
// key equivalent used to preempt; on Linux the renderer already saw the key
// first, so DevTools was never affected there.
export function buildMenuTemplate({
  platform,
  appName,
  onQuit,
}: MenuTemplateOptions): MenuItemConstructorOptions[] {
  if (platform !== 'darwin') {
    return [
      { role: 'fileMenu' },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ];
  }

  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        // Accelerator-free on purpose: the renderer turns Cmd+Q into a
        // press-and-hold, so a stray tap can't tear down running terminals.
        // (There is no way to show the key equivalent without also binding it:
        // `registerAccelerator: false` is Linux/Windows-only. The hint the
        // renderer shows on the first press is what teaches the gesture.)
        // The mouse path skips only the hold — it still lands in `before-quit`,
        // so it still asks about running terminals.
        { label: `Quit ${appName}`, click: onQuit },
      ],
    },
    {
      label: 'File',
      submenu: [{ label: 'Close Window', click: (_item, window) => window?.close() }],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
  ];
}
