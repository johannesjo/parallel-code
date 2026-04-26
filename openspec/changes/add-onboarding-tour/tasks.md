# Tasks — Add Onboarding Tour

- [ ] Add `tourCompletedAt: number | null` and `tourStep: number | null` to
      the persisted state in `src/store/persistence.ts` (and the matching
      `PersistedState` type).
- [ ] New store slice `src/store/tour.ts` with `tourActive`, `tourStep`,
      `startTour`, `nextStep`, `prevStep`, `skipTour`, `finishTour`,
      `restartTour`. Re-export from `src/store/store.ts`.
- [ ] First-launch carve-out: in the activation pass, if the loaded state
      already contains at least one project or task, set `tourCompletedAt`
      and skip activation so existing users are not interrupted.
- [ ] Defer activation while any modal flag (`showHelpDialog`,
      `showSettingsDialog`, `showNewTaskDialog`, `showArena`) is true; a
      Solid effect retriggers activation when they all close.
- [ ] On mid-phase-1 quit (`tourActive` was true at quit, tour never
      finalised), discard any persisted `tourStep` on next launch so phase 1
      restarts cleanly from step 0.
- [ ] New component `src/components/TourOverlay.tsx`: dimmer with SVG cutout,
      tooltip panel, prev/next/skip controls, focus trap, Esc-to-skip,
      `aria-live="polite"` region for step announcements.
- [ ] Add `data-tour-id` anchors to `Sidebar` (project picker, new-task
      button, merge action), `NewTaskDialog` (agent selector), and
      `TaskPanel` (terminal region + changed-files region). Final step is
      centered with no anchor.
- [ ] Anchor existence test: assert every non-null `anchorId` in the step
      registry resolves to a DOM node when the relevant components are
      mounted, so a future rename fails loudly.
- [ ] Anchor lookup uses `MutationObserver` with a 3 s absolute fallback;
      a step whose anchor never appears is logged and skipped, and a step
      whose anchor unmounts mid-display advances rather than rendering an
      empty spotlight.
- [ ] Suppress global keybindings while `tourActive` is true (only Esc and
      Enter remain live inside the tooltip).
- [ ] Mount `<TourOverlay />` in `App.tsx` next to the existing dialogs and
      gate first-launch activation in `onMount` after `loadState()`.
- [ ] Suppress the keybinding-migration banner while `tourActive` is true.
- [ ] Add a "Restart tour" button to `SettingsDialog`.
- [ ] Resume Phase 2 of the tour the first time a task panel mounts after
      Phase 1 completed (driven by the persisted `tourStep` resume token).
- [ ] Restart-tour while `tourActive` is true must run the current step's
      `afterLeave` hook (if any), reset `tourStep` to 0, clear
      `tourCompletedAt`, and re-activate after `SettingsDialog` closes.
- [ ] Treat empty-string `anchorId` as `null` (centered, no lookup) so a
      coding error producing `data-tour-id=""` does not waste the
      MutationObserver wait.
- [ ] Route hook failures and anchor-skip events through the structured
      logger (category `tour`) rather than `console.warn`; depends on or
      coexists with the `add-structured-logging` proposal.
- [ ] Tests: colocated `src/store/tour.test.ts` (matching the repo's
      colocated test convention) covering start, navigate (forward +
      back, including hook ordering), skip, finish, restart,
      restart-while-active, mid-phase-2 quit, existing-user carve-out,
      deferred-activation-while-modal-open, and the resume-after-task
      -spawn path.
- [ ] Validate with `npm run typecheck`, `npm test`, and
      `openspec validate --all --strict`.
