# Design — Add Structured Logging

## Two modules, one shape

The renderer and main process each get their own logger because they live
in separate JS contexts and Electron's IPC boundary is the natural seam.
Both modules expose the same shape so call sites read identically:

```ts
type LogContext = Record<string, unknown>;

export function debug(category: string, msg: string, ctx?: LogContext): void;
export function info(category: string, msg: string, ctx?: LogContext): void;
export function warn(category: string, msg: string, ctx?: LogContext): void;
export function error(category: string, msg: string, err?: unknown, ctx?: LogContext): void;
```

`category` is a short kebab tag (e.g. `'tasks.spawn'`, `'git.merge'`,
`'pty.fork'`). `ctx` is an optional object — typically `{ taskId, ... }`
— that gets JSON-stringified into the output line.

## Output format

A single line per log entry, prefixed with level + category + timestamp:

```
[14:23:01.412] WARN tasks.spawn — failed to symlink node_modules {"taskId":"t_abc","reason":"EEXIST"}
```

Stack traces from `error()` are appended on a second line. The format is
intentionally `console`-friendly so existing devtools still surface logs.

## Level gating

Default minimum level by build:

| Build         | Renderer                                             | Main                                  |
|---------------|------------------------------------------------------|---------------------------------------|
| dev           | `debug`                                              | `debug`                               |
| production    | `warn`                                               | `warn`                                |
| `verbose` on  | `debug` regardless of build                          | `debug` (set via `LogFromRenderer`)   |

The dev / prod determination uses `import.meta.env.DEV` in the renderer
and `process.env.NODE_ENV !== 'production'` in main. `verboseLogging` is
a persisted setting; on change, the renderer pushes the new minimum level
to main via `LogFromRenderer` so both sides stay aligned.

## Renderer → main forwarding

Every `warn` and `error` call in the renderer also fires off a
fire-and-forget `LogFromRenderer` IPC with the serialized payload. The
goal is to give main a single timeline that future work (file output,
crash bundles) can consume. The forward is best-effort — if IPC is
unavailable the renderer still logs to its own console.

`debug` and `info` are NOT forwarded by default; they would dominate the
channel and add no value at production levels. With verbose mode on,
forwarding extends to `info` (still not `debug`, to keep IPC volume
sane).

## Catch-block sweep policy

The sweep replaces three patterns:

1. `.catch(() => {})` and `try { ... } catch {}` → `.catch((err) =>
   warn('<category>', '<context>', { err }))` if recoverable;
   `error(...)` if not.
2. `console.error('msg', err)` → `error('<category>', 'msg', err)`.
3. `console.warn('msg', ...)` → `warn('<category>', 'msg', { ... })`.

Every callsite picks a category. The expectation is one category per
file or feature; this is enforced by review, not by lint. Existing
`console.warn`/`console.error` calls in tests are left alone.

## Settings UI

A "Verbose logging" toggle in `SettingsDialog`'s diagnostics section,
with a one-line explainer. The toggle persists via the existing autosave
path; it does not require a restart — the logger reads the setting
reactively.

## Known implementation risks

These are not spec-level requirements but implementation decisions that
need care during the actual build. Calling them out here so they don't
surprise the implementer.

- **Rate limiting `LogFromRenderer`.** Fire-and-forget IPC with no cap
  could flood main if a render-loop bug emits a `warn` per frame. The
  implementation should coalesce or rate-limit forwarded entries (e.g.
  drop after N entries per second per category and emit a single
  "suppressed N entries" notice). The renderer's own `console` output
  is not rate-limited.
- **Verbose toggle synchronisation.** The IPC that pushes the new level
  to main has no ack and no ordering guarantee. Quick toggling could
  briefly leave main at a different level than the renderer. The
  implementation should reconcile main's level on each `LogFromRenderer`
  payload (the level travels alongside the entry) so drift converges
  within one round-trip.
- **Lifecycle gaps.** `LogFromRenderer` is unavailable during preload
  init, after `beforeunload`, and during a renderer reload. In each of
  these windows the renderer logger MUST still emit to its own console
  so startup / shutdown diagnosis is possible without a working IPC.
- **Sweep batching.** The catch-block sweep touches dozens of files. It
  is split into per-directory phases in `tasks.md` (`src/store/`,
  `src/components/`, `electron/ipc/`) so each phase is reviewable on
  its own. Production code paths between phases retain their existing
  silent-swallow behaviour until the final sweep lands; no scenario
  promises full compliance until then.
- **No-silent-swallow enforcement.** The spec requires the rule but does
  not enforce it. A follow-up may add a custom ESLint rule that flags
  empty arrow functions in `.catch()` and empty `catch {}` blocks. Until
  then, code review is the only check.
- **Token / secret leakage.** Verbose mode exposes IPC payloads, git
  command arguments, and pty events. None of these are redacted. Users
  who turn verbose on for bug reports may inadvertently include paths,
  remote URLs, or env-derived tokens in shared logs. A future
  redaction layer is out of scope for this proposal but should be
  flagged in the verbose toggle's explainer copy.
- **Category sprawl.** Categories are kebab strings with no registry.
  Without a follow-up registry or lint rule, near-duplicates (`tasks.spawn`
  vs `task-spawn`) will appear. Initial implementation should keep the
  list short and document existing categories in `electron/log.ts`.

## Out of scope

- Writing logs to a file on disk (deliberately deferred; the timeline
  exists in main, future work can add a file sink).
- Remote / crash reporting.
- Log redaction beyond what callers pass in (callers must not put paths
  containing tokens or secrets into `ctx`).
- Replacing `console.warn` / `console.error` in test files.
