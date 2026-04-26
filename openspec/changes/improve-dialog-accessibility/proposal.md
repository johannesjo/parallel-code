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
- Update each consuming dialog to pass a stable id for its title element
  (and description where the dialog has a body lead paragraph).
- Add `aria-label` to every icon-only close button across dialogs.
- Add a visible `:focus-visible` outline rule on interactive elements
  inside dialogs (`button`, `input`, `select`, `textarea`).

## Impact

- New capability `dialog-accessibility`.
- API change to `Dialog`: two new optional props, additive, no callers
  break.
- Touches each consuming dialog component to add a title id and pass
  `labelledBy`.
- No new IPC channels, no persisted state changes, no new dependencies.
