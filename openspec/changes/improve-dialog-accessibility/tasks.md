# Tasks — Improve Dialog Accessibility

- [ ] Extend `src/components/Dialog.tsx`: set `role="dialog"` and
      `aria-modal="true"` on the panel; accept optional `labelledBy` and
      `describedBy` props; render them as `aria-labelledby` /
      `aria-describedby` on the panel; add a stable class hook (e.g.
      `.dialog-panel`) on the panel so global focus styles can target
      it through a `<Portal>`.
- [ ] Stack-aware `aria-modal`: when more than one `Dialog` is open at
      once, only the topmost carries `aria-modal="true"`. Implement via
      a tiny ref-counted store of open-dialog ids, or by reading the
      DOM order of mounted panels.
- [ ] Extend `src/components/ConfirmDialog.tsx` API: accept optional
      `labelledBy` and `describedBy` and forward to `Dialog`; generate
      its own title id via `createUniqueId` and forward that as
      `labelledBy` when a consumer does not supply one. Existing
      call-sites keep working.
- [ ] Update `SettingsDialog.tsx`: give the title an id (via
      `createUniqueId`) and pass it as `labelledBy`; add `aria-label` to
      the existing icon-only close button.
- [ ] Update `HelpDialog.tsx`: same — unique title id + `labelledBy`;
      add `aria-label` to the existing icon-only close button.
- [ ] Update `NewTaskDialog.tsx`: unique title id + `labelledBy`. (The
      dialog has no icon-only close button — its dismissal is via the
      footer "Cancel" button — so no `aria-label` work is needed here.)
- [ ] Update `MergeDialog.tsx`: pass-through of `labelledBy` is now
      handled by the extended `ConfirmDialog` API; verify the link
      resolves at render time. (`MergeDialog` does not render its own
      close button, so no `aria-label` work is needed here.)
- [ ] Update `DiffViewerDialog.tsx`: add a heading element using the
      `.dialog-sr-only` utility class (clip-based hiding that keeps the
      node in the accessibility tree, **not** `display: none` or
      `visibility: hidden`) and wire its id as `labelledBy`.
- [ ] Add a `:focus-visible` outline rule in `src/styles.css` keyed on
      `.dialog-panel` and matching the spec's broader interactive
      enumeration (`button`, `input`, `select`, `textarea`, `a[href]`,
      `[tabindex]:not([tabindex="-1"])`, `[role="button"]`,
      `[role="switch"]`, `[role="checkbox"]`, `[role="link"]`) so the
      rule covers icon buttons, toggles, and links inside dialogs.
- [ ] Add the `.dialog-sr-only` utility (clip / sr-only) to
      `src/styles.css` so `DiffViewerDialog`'s hidden heading can use
      it without inventing a recipe.
- [ ] Stack-aware `aria-modal` must restore the underlying panel's
      `aria-modal="true"` when a topmost dialog closes, so reopening a
      third dialog still finds the underlying as the next-top. Cover
      this in tests.
- [ ] Tests: add `Dialog.test.tsx`, `ConfirmDialog.test.tsx`, and
      per-dialog assertions colocated next to each component (the
      repo's convention is colocated `*.test.ts` / `*.test.tsx`, not a
      `__tests__/` subdirectory) covering: panel has `role="dialog"`
      and `aria-modal="true"`; the focus trap holds Tab inside the
      panel; `aria-labelledby` resolves to a node whose trimmed
      `textContent` is non-empty; stack-aware `aria-modal` removes the
      attribute from the underlying panel when a second dialog opens
      and restores it when the topmost closes; consumer-supplied
      `labelledBy` to `ConfirmDialog` wins over the internal generated
      id. Note that jsdom does not run AT name computation, so these
      tests verify structure, not announcement.
- [ ] Validate with `npm run typecheck`, `npm test`, and
      `openspec validate --all --strict`.
