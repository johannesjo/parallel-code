# Tasks — Add Onboarding Tour

- [ ] Add `tourCompletedAt: number | null` and `tourStep: number | null` to
      the persisted state in `src/store/persistence.ts` (and the matching
      `PersistedState` type).
- [ ] New store slice `src/store/tour.ts` with `tourActive`, `tourStep`,
      `startTour`, `nextStep`, `prevStep`, `skipTour`, `finishTour`,
      `restartTour`. Re-export from `src/store/store.ts`.
- [ ] New component `src/components/TourOverlay.tsx`: dimmer with SVG cutout,
      tooltip panel, prev/next/skip controls, focus trap, Esc-to-skip.
- [ ] Add `data-tour-id` anchors to `Sidebar` (project picker, new-task
      button, merge action), `NewTaskDialog` (agent selector), `TaskPanel`
      (terminal + changed-files), and `WindowTitleBar` or `Sidebar` (help
      button).
- [ ] Mount `<TourOverlay />` in `App.tsx` next to the existing dialogs and
      gate first-launch activation in `onMount` after `loadState()`.
- [ ] Suppress the keybinding-migration banner while `tourActive` is true.
- [ ] Add a "Restart tour" button to `SettingsDialog`.
- [ ] Resume Phase 2 of the tour the first time a task panel mounts after
      Phase 1 completed (driven by the persisted `tourStep` resume token).
- [ ] Tests: `src/store/__tests__/tour.test.ts` covering start, navigate,
      skip, finish, and the resume-after-task-spawn path.
- [ ] Validate with `npm run typecheck`, `npm test`, and
      `openspec validate --all --strict`.
