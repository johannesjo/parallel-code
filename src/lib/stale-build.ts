// A Linux package upgrade replaces app.asar while the app is still running.
// Lazy chunks are content-hashed, so the open window keeps asking for files the
// new build no longer has. Only a restart loads the matching build; retrying or
// re-rendering fails the same way.

const STALE_BUILD_MESSAGES = [
  // Chromium, when a lazy `import()` target is missing.
  'Failed to fetch dynamically imported module',
  // Vite's preload helper, when the chunk's stylesheet is missing.
  'Unable to preload CSS for',
];

/** Whether `err` means the running window is from an older build than the one installed. */
export function isStaleBuildError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return STALE_BUILD_MESSAGES.some((m) => err.message.startsWith(m));
}
