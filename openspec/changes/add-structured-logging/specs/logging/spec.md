# Logging Specification

## ADDED Requirements

### Requirement: Unified logger surface

The app SHALL expose a single logger surface in both the renderer and the
main process with four levels — `debug`, `info`, `warn`, and `error` — that
accept a category tag, a message, an optional structured context object,
and (for `error`) the underlying error or thrown value.

#### Scenario: Logger module is callable from any module

- **WHEN** a module in `src/` or `electron/` imports the logger and calls
  any of the four level functions
- **THEN** the call returns synchronously without throwing
- **AND** the caller does not need to construct any logger instance

#### Scenario: Category tag prefixes every entry

- **WHEN** a logger function is called with a category like `'tasks.spawn'`
- **THEN** the emitted line includes the level, the category, the message,
  and a serialised representation of the context object if one was passed

#### Scenario: Error includes stack trace

- **WHEN** `error(category, msg, err)` is called with an `Error` instance
- **THEN** the emitted output includes both the message line and the stack
  trace from `err`

### Requirement: Level gating by build and verbose flag

The logger SHALL gate output by level according to the current build mode
and the user's `verboseLogging` setting.

#### Scenario: Production build hides debug and info

- **WHEN** the build is production and `verboseLogging` is `false`
- **THEN** `debug(...)` and `info(...)` calls produce no output
- **AND** `warn(...)` and `error(...)` calls produce output

#### Scenario: Development build shows all levels

- **WHEN** the build is development
- **THEN** all four levels produce output regardless of `verboseLogging`

#### Scenario: Verbose flag elevates production to debug level

- **WHEN** the build is production and `verboseLogging` is `true`
- **THEN** all four levels produce output
- **AND** the renderer pushes the elevated level to the main process so
  both sides log at the same minimum level

#### Scenario: Toggling verbose at runtime applies immediately

- **WHEN** the user toggles `verboseLogging` in `SettingsDialog`
- **THEN** subsequent log calls reflect the new minimum level without
  requiring an app restart

### Requirement: No silent error swallowing

The codebase SHALL route every caught error through the logger; silent
swallows (e.g. `.catch(() => {})`) are not allowed in production code
paths.

#### Scenario: Recoverable failure logs at warn level

- **WHEN** a caught error is recoverable and the calling code can continue
  with a degraded result
- **THEN** the catch routes through `warn(category, msg, { err })` rather
  than discarding the error

#### Scenario: User-impacting failure logs at error level

- **WHEN** a caught error prevents the operation from completing in a way
  the user can see (e.g. agent spawn fails, worktree setup fails)
- **THEN** the catch routes through `error(category, msg, err)`

#### Scenario: Test files are exempt

- **WHEN** the catch lives in a test file (any file under `__tests__` or
  matching `*.test.ts`)
- **THEN** the no-silent-swallow rule does not apply

### Requirement: Renderer logs forward to main

The renderer logger SHALL forward `warn` and `error` calls (and `info`
calls when verbose mode is on) to the main process so the main process
holds a single timeline of the session.

#### Scenario: Warn and error forward unconditionally

- **WHEN** the renderer logger emits a `warn` or `error` entry
- **THEN** the renderer also fires `LogFromRenderer` with the same level,
  category, message, and serialised context

#### Scenario: Info forwards only when verbose

- **WHEN** the renderer logger emits an `info` entry
- **AND** `verboseLogging` is `true`
- **THEN** the renderer also fires `LogFromRenderer`
- **AND** when `verboseLogging` is `false`, no IPC call is made

#### Scenario: Debug never forwards

- **WHEN** the renderer logger emits a `debug` entry under any conditions
- **THEN** no `LogFromRenderer` IPC call is made

#### Scenario: IPC forwarding is best-effort

- **WHEN** `LogFromRenderer` cannot be delivered (e.g. preload not yet
  initialised)
- **THEN** the renderer still emits the entry to its own `console`
- **AND** the failure does not throw or block the calling code

### Requirement: Verbose logging setting

The app SHALL expose a `verboseLogging` toggle in settings, persist it
across launches, and default it to `false` for new installs.

#### Scenario: Default is off

- **WHEN** persisted state has no value for `verboseLogging`
- **THEN** the loaded state treats it as `false`

#### Scenario: Toggle persists

- **WHEN** the user enables the toggle in `SettingsDialog`
- **THEN** the next app launch starts with `verboseLogging` enabled

#### Scenario: Toggle is visible in settings

- **WHEN** the user opens `SettingsDialog`
- **THEN** a "Verbose logging" toggle is shown in a diagnostics section
- **AND** a one-line explainer describes that it makes the app log debug
  output to the developer console
