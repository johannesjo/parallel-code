# Add Onboarding Tour

## Why

The app's mental model — every task is a git worktree on its own branch, and
multiple agents can run in parallel — is unusual enough that first-time users
hit dead ends before they understand the workflow. `HelpDialog` lists the
shortcuts but never explains what the worktree-per-task model is, or how to get
from "fresh install" to "merged change". A short, skippable, first-launch tour
that points at the real UI elements (project picker, new task button, agent
selector, terminal panel, changed-files panel, merge action, help) closes that
gap without forcing users to read documentation.

## What changes

- Add a guided tour overlay that runs once on first launch and walks the user
  through the project → spawn → review → merge flow.
- Mount the overlay at the top level of the app shell so it can dim the page
  and spotlight real DOM anchors via `data-tour-id` attributes added to
  existing components (no DOM restructuring).
- Persist a single `tourCompletedAt` timestamp so the tour does not re-trigger
  after dismissal or completion.
- Auto-mark the tour completed for users who upgrade with prior projects or
  tasks already in their persisted state, so existing installs do not get
  hijacked by a tour they did not ask for.
- Add a "Restart tour" button to `SettingsDialog` so users can replay it on
  demand.
- Defer the existing keybinding-migration banner until the tour is dismissed
  or completed, so the two onboarding surfaces never overlap.

## Impact

- New capability `onboarding-tour`.
- New persisted store field `tourCompletedAt: number | null` (handled by the
  existing autosave persistence path; no migration code needed for additive
  optional fields).
- Additions to `App.tsx` (mount the overlay, gate first-launch activation),
  `SettingsDialog.tsx` ("Restart tour" button), and a small set of existing
  components (`Sidebar`, `NewTaskDialog`, `TaskPanel`) which gain
  `data-tour-id` attributes. The final step is centered with no anchor since
  the app does not surface a visible help button — help is invoked via the
  `?` shortcut, which the step text mentions.
- No new IPC channels, no new backend work.
