# Add Structured Logging

## Why

Errors are handled inconsistently across the renderer and main process.
Some catch blocks call `console.error`, others `console.warn`, and several
swallow the error silently with `.catch(() => {})` (e.g.
`src/store/tasks.ts:539, 552`). When an agent spawn, worktree symlink, or
pty fork fails there is often no log at all — making bug reports
unactionable. There is also no debug-level instrumentation for the IPC,
git, and pty layers in development, where it would shorten diagnosis
cycles substantially.

## What changes

- Introduce a small logger module (`src/lib/log.ts` for renderer,
  `electron/log.ts` for main) exposing `debug | info | warn | error` with
  category tags and an optional structured context object.
- Sweep every catch in `src/store/`, `src/components/`, and
  `electron/ipc/` so no error is silently swallowed; each catch routes
  to at least `warn` (recoverable) or `error` (user-impacting).
- In development (`import.meta.env.DEV` in the renderer,
  `NODE_ENV !== 'production'` in main), enable `debug` and `info` levels
  and emit IPC / git / pty traces tagged by category.
- In production, only `warn` and `error` reach the console by default.
- Add a `verboseLogging` toggle in `SettingsDialog` so users helping with
  bug reports can flip dev-level output on at runtime.
- Renderer logs at `warn` and above are forwarded to main via a new
  `LogFromRenderer` IPC channel so main can hold a single timeline (and
  later write it to a file if the implementation chooses).

## Impact

- New capability `logging`.
- New modules `src/lib/log.ts` and `electron/log.ts`.
- New IPC channel `LogFromRenderer` (renderer → main, fire-and-forget).
  As with every other channel, it must be added both to the `IPC` enum
  in `electron/ipc/channels.ts` and to the preload script's allowlist
  before the renderer can call it.
- Sweep touches dozens of files split into per-directory phases. The
  spec admits a transitional period where earlier-swept directories
  are compliant and later ones still hold legacy patterns.
- New persisted field `verboseLogging: boolean` (default `false`); the
  loader coerces non-boolean values to `false` to avoid corrupted state
  silently enabling verbose mode in production.
- No new runtime dependencies.
