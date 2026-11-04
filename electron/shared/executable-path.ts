const EXECUTABLE_RE = /\.(sh|bash|exe|bat|cmd|app|command|desktop|appimage|run)$/i;

/** Files the OS default app would run rather than show, so nothing opens them with it. */
export function isExecutablePath(filePath: string): boolean {
  // A macOS bundle is a folder, so a link to `Foo.app/` would launch it too.
  return EXECUTABLE_RE.test(filePath.replace(/\/+$/, ''));
}
