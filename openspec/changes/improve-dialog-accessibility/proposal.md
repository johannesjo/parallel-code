# Improve Dialog Accessibility

## Why

The base `Dialog` wrapper in `src/components/Dialog.tsx` provides a focus
trap and ESC-to-close, but it does not set `role="dialog"`,
`aria-modal="true"`, or link a title via `aria-labelledby`. Every dialog in
the app inherits this gap: `SettingsDialog`, `NewTaskDialog`, `HelpDialog`,
`ConfirmDialog`, `MergeDialog`, `DiffViewerDialog`. Screen-reader users
cannot tell they have entered a modal, the dialog title is not announced,
and several icon-only close buttons lack `aria-label`. Visible focus
indicators on interactive elements inside dialogs are inconsistent (the
panel itself has `outline: 'none'` at `Dialog.tsx:99`). The app is
otherwise keyboard-first, so closing this gap is high-leverage and
low-cost.

## What changes

- Extend `Dialog` to set `role="dialog"` and `aria-modal="true"` on its
  panel, and to accept new optional props `labelledBy` and `describedBy`
  that render as `aria-labelledby` / `aria-describedby` on the panel.
  When a dialog opens on top of another dialog, only the topmost panel
  carries `aria-modal="true"`.
- Extend `ConfirmDialog`'s API to accept and forward `labelledBy` /
  `describedBy` (today it only accepts a `title: string` and renders its
  own untagged `<h2>`), and to generate a unique id for that title via
  `createUniqueId` so consumers like `MergeDialog` get a working link
  without restructuring.
- Update each consuming dialog (`SettingsDialog`, `NewTaskDialog`,
  `HelpDialog`, `ConfirmDialog`, `DiffViewerDialog`) to attach a unique
  id to its title element and pass that id as `labelledBy`. `MergeDialog`
  inherits via `ConfirmDialog`.
- Give `DiffViewerDialog` a heading (visible or visually hidden via the
  clip / sr-only pattern) so it has something to link to.
- Add `aria-label` to icon-only close buttons that exist today
  (`SettingsDialog`, `HelpDialog`).
- Add a visible `:focus-visible` outline rule on interactive elements
  inside dialogs (`button`, `input`, `select`, `textarea`), expressed via
  a class hook on the panel so it survives `<Portal>` mounting outside
  the app root.

## Impact

- New capability `dialog-accessibility`.
- API change to `Dialog`: two new optional props, additive, no callers
  break.
- API change to `ConfirmDialog`: two new optional props plus an
  internally-generated title id; existing call-sites keep working.
- Touches each consuming dialog component to attach a title id and pass
  `labelledBy`.
- No new IPC channels, no persisted state changes, no new dependencies.
