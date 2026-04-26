# Onboarding Tour Specification

## ADDED Requirements

### Requirement: First-launch activation

The app SHALL run the onboarding tour exactly once per install, on the first
launch where persisted state has no record of the tour having completed or
been skipped, and SHALL skip the tour for users who already have prior task
or project data so existing installs are not interrupted by a tour they did
not ask for.

#### Scenario: Fresh install starts the tour

- **WHEN** the app boots and persisted state's `tourCompletedAt` is `null`
- **AND** the persisted state has no projects and no tasks
- **THEN** the app activates the tour at step 0 once `loadState()` has
  resolved and no modal dialog is currently open

#### Scenario: Existing user with prior data skips the tour

- **WHEN** the app boots and `tourCompletedAt` is `null`
- **AND** the persisted state contains at least one project or one task
- **THEN** the app sets `tourCompletedAt` to the current timestamp without
  activating the tour
- **AND** the tour does not activate on this or any subsequent launch unless
  the user invokes "Restart tour"

#### Scenario: Returning user does not see the tour

- **WHEN** the app boots and `tourCompletedAt` is a non-null number
- **THEN** the tour does not activate
- **AND** no overlay is rendered

#### Scenario: Activation defers when a modal is open

- **WHEN** the activation conditions are otherwise met
- **AND** a modal dialog (`HelpDialog`, `SettingsDialog`, `NewTaskDialog`,
  or `ArenaOverlay`) is open at the moment activation would occur
- **THEN** the app holds activation
- **AND** activates the tour as soon as all such modals close, provided
  `tourCompletedAt` is still `null`

#### Scenario: Tour suppresses the keybinding migration banner

- **WHEN** the tour is active
- **AND** the keybinding migration banner would otherwise be shown
- **THEN** the banner is hidden until the tour finishes or is skipped

### Requirement: Step navigation

The tour SHALL let the user move forward, move backward, and skip out of the
flow at any step.

#### Scenario: Advance to next step

- **WHEN** the user clicks "Next" or presses Enter on a non-final step
- **THEN** `tourStep` increments by 1
- **AND** any `afterLeave` hook of the previous step runs
- **AND** any `beforeEnter` hook of the next step runs before the new anchor
  is queried

#### Scenario: Move to previous step

- **WHEN** the user clicks "Back" on any step except step 0
- **THEN** `tourStep` decrements by 1
- **AND** the step being left runs its `afterLeave` hook before the new
  current step's `beforeEnter` hook runs and the new anchor is queried,
  so a hook that opens a dialog for one step is paired with a hook that
  closes it on the way back

#### Scenario: Skip the tour

- **WHEN** the user clicks "Skip" or presses Esc at any step
- **THEN** the tour deactivates
- **AND** `tourCompletedAt` is set to the current timestamp
- **AND** the tour does not re-activate on subsequent launches

#### Scenario: Finish the tour

- **WHEN** the user clicks "Done" on the final step
- **THEN** the tour deactivates
- **AND** `tourCompletedAt` is set to the current timestamp

### Requirement: Spotlight follows real DOM anchors

The tour SHALL spotlight existing UI elements via `data-tour-id` attributes
without restructuring the DOM, and SHALL keep the spotlight aligned as the
window resizes or layout changes.

#### Scenario: Anchor exists when step activates

- **WHEN** a step with a non-null `anchorId` activates
- **AND** an element with `data-tour-id="<anchorId>"` is in the DOM
- **THEN** the overlay renders a cutout matching that element's bounding
  rectangle
- **AND** the tooltip is positioned according to the step's `placement`

#### Scenario: Anchor missing when step activates

- **WHEN** a step with a non-null `anchorId` activates
- **AND** no matching element appears in the DOM before the
  implementation-defined wait expires
- **THEN** the tour skips the step and advances to the next one
- **AND** the skip is logged

#### Scenario: Anchor disappears mid-step

- **WHEN** the anchor element of the currently displayed step is removed
  from the DOM (e.g. the user collapses a panel via shortcut)
- **THEN** the tour advances to the next step rather than rendering a
  spotlight over an empty rectangle

#### Scenario: Window resize updates the spotlight

- **WHEN** the window resizes or the anchor element's bounding rectangle
  changes
- **THEN** the spotlight cutout and tooltip position update to match without
  closing the overlay

#### Scenario: Centered step has no spotlight

- **WHEN** a step's `anchorId` is `null`
- **THEN** the overlay renders a uniform dimmer with no cutout
- **AND** the tooltip is centered in the viewport

### Requirement: Two-phase flow when no project exists

The tour SHALL split into two phases so a fresh user with no project can
still see all steps without the app fabricating demo data.

#### Scenario: First launch with no project

- **WHEN** the tour activates on a fresh install with zero projects
- **THEN** the tour runs phase 1 (steps that explain projects, the new-task
  button, and the agent selector)
- **AND** the final phase-1 step prompts the user to create their first task
  or skip
- **AND** the `tourStep` resume token is persisted so phase 2 can resume

#### Scenario: Phase 2 resumes after first task

- **WHEN** phase 1 completed without skipping
- **AND** a task panel mounts for the first time afterward
- **THEN** the tour activates phase 2 (steps that explain the terminal,
  changed-files panel, merge action, and help)

#### Scenario: Phase 2 resume token persists across launches

- **WHEN** phase 1 completed without skipping in a previous session
- **AND** no task panel has yet mounted
- **THEN** the resume token persists across app restarts
- **AND** phase 2 activates the next time a task panel mounts in any future
  session, regardless of how many launches have passed

#### Scenario: Mid-phase-1 quit restarts phase 1

- **WHEN** the app quits while phase 1 is mid-flight (the user neither
  finished phase 1 nor explicitly skipped)
- **THEN** the next launch treats the tour as not yet started
- **AND** phase 1 begins again at step 0
- **AND** any partial `tourStep` value from the prior session is discarded

#### Scenario: Skipping in either phase finalises the tour

- **WHEN** the user skips during phase 1 or phase 2
- **THEN** `tourCompletedAt` is set
- **AND** any phase-2 resume token is cleared
- **AND** the tour does not re-activate on subsequent launches

### Requirement: Restart from settings

The app SHALL let the user replay the tour from the settings dialog.

#### Scenario: Restart tour clears completion

- **WHEN** the user clicks "Restart tour" in `SettingsDialog`
- **THEN** `tourCompletedAt` is set to `null`
- **AND** the `tourStep` resume token is reset
- **AND** the tour activates immediately at step 0

### Requirement: Accessibility

The tour SHALL be operable by keyboard alone, announce its tooltip to
assistive technology, and respect the user's reduced-motion preference.

#### Scenario: Keyboard focus is trapped in the tooltip

- **WHEN** the tour is active
- **THEN** Tab and Shift-Tab cycle focus among the tooltip's interactive
  controls only
- **AND** focus does not escape into the dimmed background

#### Scenario: Tooltip is announced as a dialog

- **WHEN** the tooltip renders
- **THEN** it has `role="dialog"`
- **AND** its title is referenced by `aria-labelledby`
- **AND** its body text is referenced by `aria-describedby`

#### Scenario: Reduced motion disables transitions

- **WHEN** the user agent reports `prefers-reduced-motion: reduce`
- **THEN** the spotlight and tooltip render without fade-in or movement
  transitions

#### Scenario: Step transitions are announced to assistive technology

- **WHEN** the active step changes (forward, back, or initial activation)
- **THEN** an `aria-live="polite"` region announces the new step's position
  ("Step N of M") and its title
- **AND** the announcement does not duplicate when the same step re-renders
  for non-step reasons such as an anchor reposition
