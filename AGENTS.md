# Parallel Code

Electron desktop app for running coding agents in isolated Git worktrees. Desktop releases target **macOS and Linux only**. The phone UI is a separate web frontend.

- **Frontend:** SolidJS, strict TypeScript, Vite.
- **Backend:** Node.js, Electron, node-pty.
- **Package manager:** npm. CI uses Node.js 22.
- Shared project guidance lives here; `CLAUDE.md` imports this file. Keep personal model and workflow preferences in global instructions.

## Development and verification

- `npm run dev` starts the Electron development app.
- `npm run build` builds and packages the app; `npm run build:remote` rebuilds the phone UI.
- `npm run typecheck` checks frontend types and their imports; it does **not** cover the entire Electron backend. `npm run compile` checks backend TypeScript and emits `dist-electron/`.
- Run focused tests while developing:
  - `npm run test:unit -- path/to/file.test.ts` for logic/backend tests (Node environment).
  - `npm run test:client -- path/to/file.client.test.tsx` for DOM/component tests (happy-dom).
- For code changes, run `npm run check` and relevant tests before handoff. It runs backend compilation, frontend type checking, lint, and a formatting check. For documentation-only changes, check the changed files with Prettier.
- `npm test` runs both test suites. `npm run test:ci` adds unit coverage thresholds. `npm run check:static` includes dead-code and architecture checks as well as type checking and lint; use it when changing exports or module dependencies.
- See `.github/workflows/ci.yml` for the complete CI sequence, including security-rule fixture tests and the real-PTY coordinator test. Ordinary test runs skip opt-in PTY, Docker, and real-agent suites; real-agent tests can launch paid services. Report skipped or unavailable verification.
- CI tests that Semgrep rules work on fixtures; it does not scan the repository with Semgrep. `npm run lint:security` and `npm run lint:secrets` run separate scans and require Semgrep and Gitleaks respectively.
- happy-dom cannot verify native Electron views. For browser-preview changes, follow the native smoke checks in `docs/browser-preview.md`.

When committing, use conventional commit messages, such as `fix(terminal): restore focus`. Git hooks enforce the format and run `lint-staged`, `npm run check`, and a lockfile check on commit; pushing runs `check` and `npm test`. Changes to `package.json` must include the corresponding `package-lock.json` update.

## Architecture and conventions

- Use SolidJS function components, signals, and stores. Preserve reactive property access and clean up subscriptions, timers, and terminal resources when their owner is disposed. The component convention does not prohibit utility classes.
- Keep strict TypeScript; use `unknown` and narrow it instead of introducing `any`. Lint treats warnings as failures, including non-null assertions.
- Use the existing loggers in `src/lib/log.ts` (desktop renderer) and `electron/log.ts` (main). Lint permits `console.warn` and `console.error`, but rejects other console methods unless explicitly exempted.
- Follow the existing store domain modules. `src/store/core.ts` owns the main store; `src/store/store.ts` re-exports domain operations.
- Electron TypeScript uses NodeNext resolution: follow existing relative imports with `.js` suffixes.
- Desktop renderer/main communication uses Electron IPC. The phone UI uses the existing HTTP/WebSocket API. Renderer imports of backend code are restricted to the shared modules allowed in `.dependency-cruiser.cjs`.

### IPC changes

- Named channels originate in `electron/ipc/channel-manifest.json`; `electron/ipc/channels.ts` exports the manifest and its type.
- When adding a named channel, update the manifest and the inline allowlist in `electron/preload.cjs`, plus the handler and frontend call site as needed. The sandboxed preload cannot require the local JSON manifest.
- Desktop frontend helpers are in `src/lib/ipc.ts`; handlers are registered in `electron/ipc/register.ts` and subsystem registration modules such as `electron/documents/register.ts`.
- Dynamic `channel:<uuid>` streams are managed by `Channel<T>` and are separate from manifest entries.
- Run `npm run test:unit -- electron/preload-allowlist.test.ts` after changing named channels or the preload allowlist.

### Worktree and runtime boundaries

- Worktree cleanup must not follow symlinks into the main checkout. Preserve the handling in `electron/ipc/worktree-cleanup.ts`.
- Subtask instructions injected by the app are temporary runtime content. Keep them out of committed project guidance. When editing instruction-file handling, read `electron/mcp/preamble.ts`; do not copy its reserved delimiter strings into these guidance files, because cleanup treats them as runtime markers even inside Markdown examples.
- Preserve remote token roles and task scoping. Keep coordinator tokens out of shared URLs and bearer tokens out of logs; reuse the validation and redaction helpers in `electron/remote/server.ts`.
- Use the existing atomic-write helpers in `electron/mcp/atomic.ts` for coordinator persistence. Validate setup inputs before filesystem side effects; see `.semgrep/filesystem-safety.yml`.

## Where to look

- `src/components/`, `src/lib/`, `src/store/`: desktop UI, frontend utilities, and app state.
- `electron/ipc/`: terminal, Git/worktree, task, persistence, and other desktop handlers.
- `electron/mcp/`: MCP server and subtask coordinator; `electron/agent-hooks/`: agent lifecycle hooks.
- `src/remote/`, `electron/remote/`: phone UI and its server.
- `src/documents/`, `electron/documents/`: document workspaces; see `docs/document-workspaces.md`.
- `docs/browser-preview.md`: native browser architecture, limitations, and verification.
- `docs/pooled-workspaces.md`: leasing a ready environment instead of building a worktree, for projects that are a directory of git repositories.
- `docs/architecture-overview.html`: broader architecture overview. New files under `docs/` are ignored unless explicitly included in `.gitignore`.
