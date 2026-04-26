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
with a one-line explainer and a "Reveal log location" link in dev (no-op
in prod for now). Toggle persists via the existing autosave path; it
does not require a restart — the logger reads the setting reactively.

## Out of scope

- Writing logs to a file on disk (deliberately deferred; the timeline
  exists in main, future work can add a file sink).
- Remote / crash reporting.
- Log redaction beyond what callers pass in (callers must not put paths
  containing tokens or secrets into `ctx`).
- Replacing `console.warn` / `console.error` in test files.
