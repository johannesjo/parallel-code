# Tasks — Improve Dialog Accessibility

- [ ] Extend `src/components/Dialog.tsx`: set `role="dialog"` and
      `aria-modal="true"` on the panel; accept optional `labelledBy` and
      `describedBy` props; render them as `aria-labelledby` /
      `aria-describedby` on the panel.
- [ ] Update `SettingsDialog.tsx`: give the title an id and pass it as
      `labelledBy`; add `aria-label` to the icon-only close button.
- [ ] Update `NewTaskDialog.tsx`: same — title id + `labelledBy`; add
      `aria-label` to the close button.
- [ ] Update `HelpDialog.tsx`: same.
- [ ] Update `ConfirmDialog.tsx`: same; the dialog already has an h2 title
      (lines 40–48) — wire it to `labelledBy`.
- [ ] Update `MergeDialog.tsx`: passes through `ConfirmDialog`, so the
      title id flows up via `ConfirmDialog`'s prop pass-through; verify
      the link is preserved.
- [ ] Update `DiffViewerDialog.tsx`: add a visually present or visually
      hidden title element so `labelledBy` has something to point at.
- [ ] Add a global `:focus-visible` outline rule scoped to interactive
      elements inside dialogs (likely a class added to the dialog panel
      and a CSS rule in `src/styles.css` or a colocated style block).
- [ ] Tests: extend `src/components/__tests__/` to assert each dialog
      panel renders with `role="dialog"`, `aria-modal="true"`, and a
      resolvable `aria-labelledby` reference.
- [ ] Validate with `npm run typecheck`, `npm test`, and
      `openspec validate --all --strict`.
