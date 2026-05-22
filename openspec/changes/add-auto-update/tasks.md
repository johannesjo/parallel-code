# Tasks — Add In-App Auto-Update

- [x] Add `electron-updater` dependency, a GitHub `publish` target, and a `zip`
      macOS artifact to the `electron-builder` config in `package.json`.
- [x] Add `updates` IPC channels to the `IPC` enum in
      `electron/ipc/channels.ts` and mirror them into the `preload.cjs`
      allowlist.
- [x] Add a backend `electron/ipc/updater.ts` module wrapping `autoUpdater`:
      init/check/download/quit-and-install, broadcasting an
      `update_status_changed` event to the renderer; degrade gracefully when
      the build is not auto-updatable (dev run, unsupported target).
- [x] Register the updater IPC handlers in `electron/ipc/register.ts`, init
      the updater on window creation, and run one silent check after launch.
- [x] Add the `UpdateStatus` payload type to `src/ipc/types.ts`.
- [x] Add a renderer store slice `src/store/updates.ts` (status signal +
      `update_status_changed` subscription + check/download/install helpers)
      and export it from the store barrel.
- [x] Add an Updates section to the Diagnostics tab of
      `src/components/SettingsDialog.tsx` (current version, check button,
      status line, download progress, restart-and-install button).
- [x] Wire the update subscription in `src/App.tsx`.
- [x] Add an `UpdateButton` component to the `Sidebar` header that appears only
      when an update is available/downloading/downloaded and performs the
      phase-appropriate action (download / restart & install).
- [x] Validate with `npm run typecheck`, `npm test`, and
      `openspec validate --all --strict`.
