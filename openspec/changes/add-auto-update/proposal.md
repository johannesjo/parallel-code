# Add In-App Auto-Update

## Why

Parallel Code ships as a macOS DMG and a Linux AppImage/deb. Today a user who
wants a newer version must notice a release exists, download the installer by
hand, and reinstall over the running app. There is no in-app signal that an
update is available and no way to apply one without that manual reinstall
(issue #91).

## What changes

- The app checks GitHub Releases for a newer published version: silently once
  shortly after launch, and on demand from a new **Updates** section in
  Settings → Diagnostics.
- When a newer version exists the Updates section reports it and offers a
  **Download update** action; download progress is shown.
- An update control also appears in the **sidebar header** whenever an update
  is available, downloading, or downloaded — so it is discoverable without
  opening Settings. It is hidden when the app is up to date, unsupported, or
  the last check failed.
- Once downloaded, a **Restart & install** action relaunches the app onto the
  new version — no manual reinstall. A deferred install is also applied
  automatically the next time the app quits.
- The Updates section always shows the current version and the outcome of the
  last check (up to date / available / error), so the feature is discoverable
  and its state legible.
- Auto-update is a packaged-build capability. In dev runs and for the Linux
  `deb` target (which has no in-place update channel) the section reports that
  updates are unavailable rather than failing.

## Impact

- New capability `updates`.
- Adds `electron-updater` and a GitHub `publish` target to the
  `electron-builder` config; adds a `zip` artifact to the macOS build so
  `electron-updater` can apply macOS updates.
- New backend module `electron/ipc/updater.ts`; new IPC channels
  (`check_for_updates`, `download_update`, `quit_and_install_update`,
  `get_update_status`, `update_status_changed`) wired through
  `channels.ts`, `preload.cjs`, and `register.ts`.
- New renderer store slice `src/store/updates.ts`, an Updates section in
  `src/components/SettingsDialog.tsx`, and a new `UpdateButton` component in
  the `Sidebar` header; subscription wired in `src/App.tsx`.
- No persisted-state or schema change — update status is transient.
