# Tasks — Add Structured Logging

- [ ] Add new IPC channel `LogFromRenderer` to `electron/ipc/channels.ts`
      and the preload allowlist.
- [ ] Implement `electron/log.ts`: `debug | info | warn | error` with
      category tags, level gating by build, and a handler for
      `LogFromRenderer` that funnels renderer entries into the same
      output stream. The `error` function takes a required `err: unknown`
      argument before the optional `ctx`, so it cannot be confused with
      the optional context object on the other levels.
- [ ] Implement `src/lib/log.ts`: same surface as the main logger; emits
      to `console` and forwards `warn`/`error` (and `info` when verbose)
      to main via `LogFromRenderer`. Forwarding includes a per-second
      rate cap per category to protect against flood loops.
- [ ] Implement safe serialisation: non-`Error` throwables are normalised
      to a stable string; `ctx` objects with circular references or
      unserialisable members fall back to a placeholder representation
      so the logger never throws.
- [ ] Add persisted field `verboseLogging: boolean` (default `false`) to
      `PersistedState` in `src/store/types.ts` and the loader/saver in
      `src/store/persistence.ts`. The loader must coerce non-boolean
      values to `false` so corrupted persisted state cannot silently
      enable verbose mode in production.
- [ ] Wire the renderer logger to read `verboseLogging` reactively so
      toggling the setting takes effect without a restart; piggy-back
      the current level on each `LogFromRenderer` payload so main
      reconciles within one round-trip.
- [ ] Add a "Verbose logging" toggle in `SettingsDialog` under a
      diagnostics section, with explainer copy that warns logs may
      include paths and command arguments before sharing them.
- [ ] Phase 1 — sweep `src/store/`: route every catch through the
      renderer logger; replace silent swallows with `warn` or `error`.
- [ ] Phase 2 — sweep `src/components/`: same treatment.
- [ ] Phase 3 — sweep `electron/ipc/`: same treatment via the main
      logger.
- [ ] Add debug traces at category `ipc` (every IPC handler entry/exit),
      `git` (every git command + exit code), `pty` (spawn, exit,
      signal). These are `debug` level so they only show in dev or with
      verbose on.
- [ ] Tests colocated next to the modules (the repo's convention is
      `*.test.ts` next to the file, not a `__tests__/` directory):
      `src/lib/log.test.ts` and `electron/log.test.ts` covering level
      gating, category formatting, forwarding behavior, the per-category
      rate cap and suppression notice, the `verbose` runtime flip,
      circular-ctx safety (including a Proxy whose trap throws),
      non-Error normalisation (including non-string `stack`),
      `error(cat, msg, undefined)` omitting the stack section, and
      corrupted `verboseLogging` coercion to `false`.
- [ ] Validate with `npm run typecheck`, `npm test`, and
      `openspec validate --all --strict`.
