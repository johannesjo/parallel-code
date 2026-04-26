# Dialog Accessibility Specification

## ADDED Requirements

### Requirement: Dialog panels declare themselves as modal dialogs

Every modal dialog mounted via the shared `Dialog` wrapper SHALL render
its panel with `role="dialog"` and `aria-modal="true"` so assistive
technology can recognise it as a modal context.

#### Scenario: Base Dialog sets the modal role

- **WHEN** any dialog renders via the shared `Dialog` wrapper
- **THEN** the panel element has `role="dialog"` and `aria-modal="true"`

#### Scenario: Both attributes are present together

- **WHEN** the panel renders
- **THEN** neither `role="dialog"` nor `aria-modal="true"` may be omitted
  on the panel element

### Requirement: Dialog panels link to their title

Every dialog SHALL link its panel to a visible (or visually hidden) title
element via `aria-labelledby` so the title is announced when the dialog
opens.

#### Scenario: Dialog accepts a labelledBy prop

- **WHEN** a consumer passes `labelledBy="some-id"` to `Dialog`
- **THEN** the panel renders `aria-labelledby="some-id"`

#### Scenario: Each consuming dialog provides a title id

- **WHEN** any of `SettingsDialog`, `NewTaskDialog`, `HelpDialog`,
  `ConfirmDialog`, `MergeDialog`, or `DiffViewerDialog` renders
- **THEN** its title element has a stable id
- **AND** the dialog passes that id to `Dialog` as `labelledBy`
- **AND** the referenced element exists in the rendered DOM

#### Scenario: DiffViewerDialog provides a title even if visually minimal

- **WHEN** `DiffViewerDialog` renders
- **THEN** it includes either a visible heading or a visually hidden
  heading whose id is passed as `labelledBy`

### Requirement: Dialog panels can describe themselves

The shared `Dialog` SHALL accept an optional `describedBy` prop and render
it as `aria-describedby` on the panel so longer dialog bodies can be
announced by assistive technology.

#### Scenario: Dialog accepts a describedBy prop

- **WHEN** a consumer passes `describedBy="some-id"` to `Dialog`
- **THEN** the panel renders `aria-describedby="some-id"`

#### Scenario: describedBy is optional

- **WHEN** a consumer omits `describedBy`
- **THEN** the panel renders without an `aria-describedby` attribute

### Requirement: Icon-only close buttons have an accessible name

Every icon-only close button rendered by a dialog SHALL expose an
accessible name via `aria-label` so screen-reader users can identify it.

#### Scenario: Close button has aria-label

- **WHEN** a dialog renders an icon-only close button (no visible text)
- **THEN** the button has an `aria-label` whose value clearly identifies
  it as the close action (e.g. `"Close dialog"` or `"Close settings"`)

### Requirement: Visible focus indicators inside dialogs

Interactive elements inside dialog panels SHALL show a visible focus
indicator when focused via keyboard, distinct from the hover or active
state.

#### Scenario: Buttons inside dialogs show a focus ring

- **WHEN** a `button`, `input`, `select`, or `textarea` inside a dialog
  panel receives focus via Tab or Shift-Tab
- **THEN** a visible focus indicator (e.g. an outline or ring matching
  the app's accent colour) is rendered

#### Scenario: Indicator does not appear on mouse interaction alone

- **WHEN** the same element receives focus via mouse click
- **THEN** the focus indicator follows the standard `:focus-visible`
  semantics so it does not appear for pointer-only interaction
