# Tasks — Add Structured Logging

- [ ] Add new IPC channel `LogFromRenderer` to `electron/ipc/channels.ts`
      and the preload allowlist.
- [ ] Implement `electron/log.ts`: `debug | info | warn | error` with
      category tags, level gating by build, and a handler for
      `LogFromRenderer` that funnels renderer entries into the same
      output stream.
- [ ] Implement `src/lib/log.ts`: same surface as the main logger; emits
      to `console` and forwards `warn`/`error` (and `info` when verbose)
      to main via `LogFromRenderer`.
- [ ] Add persisted field `verboseLogging: boolean` (default `false`) to
      `PersistedState` in `src/store/types.ts` and the loader/saver in
      `src/store/persistence.ts`.
- [ ] Wire the renderer logger to read `verboseLogging` reactively so
      toggling the setting takes effect without a restart; push the new
      level to main on each change.
- [ ] Add a "Verbose logging" toggle in `SettingsDialog` under a
      diagnostics section.
- [ ] Sweep every catch in `src/store/` and `src/components/` and route
      through the renderer logger; replace silent swallows with `warn`
      or `error` as appropriate.
- [ ] Sweep every catch in `electron/ipc/` and route through the main
      logger; replace silent swallows similarly.
- [ ] Add dev-only debug traces at category `ipc` (every IPC handler
      entry/exit), `git` (every git command + exit code), `pty` (spawn,
      exit, signal). These should be `debug` level so they only show
      with verbose on or in dev.
- [ ] Tests: `src/lib/__tests__/log.test.ts` and
      `electron/__tests__/log.test.ts` covering level gating, category
      formatting, forwarding behavior, and the `verbose` runtime flip.
- [ ] Validate with `npm run typecheck`, `npm test`, and
      `openspec validate --all --strict`.
