# Design — Add Onboarding Tour

## Trigger and gating

The tour is gated by a single persisted field, `tourCompletedAt: number |
null`, stored alongside other UI state in `src/store/persistence.ts`. The
field is `null` for fresh installs and existing users alike — meaning existing
users who upgrade also see the tour once. This is intentional: the tour
explains the worktree model, which existing users may have figured out
imperfectly.

The tour activates from `App.tsx` `onMount`, after `loadState()` resolves, if
`tourCompletedAt === null` and no other modal is open. If the keybinding
migration banner would also have been shown, the tour suppresses it; on
completion or skip, the banner can render on the next state change.

## Architecture

A new store slice `src/store/tour.ts` exposes:

- `tourActive: boolean`
- `tourStep: number` (0-indexed)
- `startTour()`, `nextStep()`, `prevStep()`, `skipTour()`, `finishTour()`
- `restartTour()` — clears `tourCompletedAt` and calls `startTour()`

A new component `src/components/TourOverlay.tsx` renders when `tourActive` is
true. It is mounted in `App.tsx` near the existing dialogs (`HelpDialog`,
`SettingsDialog`, `ArenaOverlay`). Steps are declared as data, not JSX:

```ts
type TourStep = {
  id: string;
  anchorId: string | null; // null = centered, no spotlight
  title: string;
  body: string;
  placement: 'top' | 'right' | 'bottom' | 'left' | 'center';
  beforeEnter?: () => void; // e.g. open NewTaskDialog so its anchor exists
  afterLeave?: () => void;  // e.g. close it again
};
```

The overlay locates its anchor via `document.querySelector('[data-tour-id="<
id>"]')`, observes its `getBoundingClientRect`, and renders:

- A full-viewport dimmer with an SVG cutout over the anchor's bounding rect.
- A tooltip panel positioned relative to the anchor (simple heuristic; no
  popper dependency).
- Prev / Next / Skip controls; step counter ("3 of 8"); Esc to skip.

Anchor positions are recomputed on `resize` and via a `ResizeObserver` on the
anchor element so the spotlight follows window resizes and layout shifts.

## Steps

| # | `anchorId`              | Teaches                                                                |
|---|-------------------------|------------------------------------------------------------------------|
| 1 | `null` (centered)       | Welcome; one-line model: "every task = its own git worktree."          |
| 2 | `tour-project-picker`   | "Pick or add a project — your repo lives here."                        |
| 3 | `tour-new-task`         | "Each task creates a branch + worktree automatically."                 |
| 4 | `tour-agent-selector`   | "Choose Claude Code, Codex, Gemini, or a custom agent."                |
| 5 | `tour-task-terminal`    | "Watch the agent work live; type to interject."                        |
| 6 | `tour-changed-files`    | "Review diffs as files change; click for full Monaco view."            |
| 7 | `tour-merge-action`     | "Merge back to main from the sidebar when you're happy."               |
| 8 | `tour-help-button`      | "Press `?` anytime — full shortcut list lives here. You're done."      |

Step 4 needs the `NewTaskDialog` open so its anchor exists. The step uses
`beforeEnter: () => toggleNewTaskDialog(true)` and
`afterLeave: () => toggleNewTaskDialog(false)`. The dialog's normal
keybindings are suppressed while the tour is active so the user can't
accidentally submit a task during the tour.

## First-run with no project

If the user has no project at the time the tour starts, steps 5–7 have no
DOM anchor. We resolve this by partitioning the tour into two phases:

- **Phase 1 (steps 1–4)** runs immediately on first launch and ends with a
  prompt: "Create your first task to continue the tour, or skip."
- **Phase 2 (steps 5–8)** resumes the first time a task panel mounts after
  Phase 1 completed, gated by a `tourStep` resume token persisted alongside
  `tourCompletedAt`.

Both phases share the same store and overlay; only the gating logic differs.
Skipping in either phase finalises `tourCompletedAt` so the tour does not
re-trigger.

## Accessibility

- Tooltip is `role="dialog"` with `aria-labelledby` (title) and
  `aria-describedby` (body).
- `lib/focus-trap.ts` is reused to trap focus inside the tooltip; on close,
  focus is restored to the anchor element.
- `prefers-reduced-motion: reduce` disables the spotlight transition and any
  fade-ins.
- The overlay's dimmer has `aria-hidden="true"` so screen readers ignore it.

## Out of scope

- Per-OS or per-agent tour variants.
- Telemetry on tour completion (no infra exists today).
- Animations, video, or interactive demo data.
- Replacing or restructuring `HelpDialog`.
