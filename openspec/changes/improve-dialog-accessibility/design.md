# Design — Improve Dialog Accessibility

## Why a design doc

The change is mostly mechanical (add ARIA attributes, wire title ids), but
two things are subtle enough to warrant a written design: the
`ConfirmDialog` API extension that `MergeDialog` depends on, and the
Portal-aware CSS scope for `:focus-visible`. Everything else lives in the
spec.

## ConfirmDialog API extension

`ConfirmDialog` currently accepts `title: string` and renders its own
untagged `<h2>`. `MergeDialog` (and any future wrapper) cannot point
`aria-labelledby` at that heading because it has no id.

The extension:

- Add optional `labelledBy?: string` and `describedBy?: string` props.
- Always generate a title id via Solid's `createUniqueId()` and apply it
  to the rendered `<h2>` so the heading is reliably referenceable.
- When the consumer does NOT supply `labelledBy`, forward
  `ConfirmDialog`'s own generated id to `Dialog` so the link works
  out of the box.
- When the consumer DOES supply `labelledBy`, forward that value
  unchanged; `ConfirmDialog`'s generated id remains on the `<h2>` but
  is unused as a label reference. This avoids overwriting the
  consumer's intent and the duplicate id is harmless.
- Forward `describedBy` to `Dialog` if the consumer passes one;
  `ConfirmDialog` does not synthesise a description id.

`MergeDialog` keeps its `<ConfirmDialog title="..."/>` call-site
unchanged; the link is set up automatically because the generated id is
forwarded.

Existing `ConfirmDialog` call-sites continue to work unmodified — the
extension is purely additive.

## Stack-aware `aria-modal`

The app already supports nested dialogs (e.g. confirm-on-close on top of
`MergeDialog`). Two simultaneously-open `aria-modal="true"` panels confuse
some assistive technologies because both claim to trap navigation.

The implementation chooses one of:

- **A — DOM order:** the panel that ends up topmost in document order at
  render time keeps `aria-modal`; the others render without it.
- **B — Ref-counted store:** a tiny module-level array tracks open
  panels by id; only the last entry's panel renders `aria-modal="true"`.

Option B is more deterministic and survives portals (which Option A's DOM
ordering doesn't reliably handle). Recommend B.

## `:focus-visible` scope through a Portal

`Dialog` mounts via Solid `<Portal>` to `document.body`, so a CSS rule
written as a descendant of the app shell (e.g.
`#app .panel button:focus-visible`) does not match.

The fix is a class hook on the panel itself:

```css
.dialog-panel
  :is(
    button,
    input,
    select,
    textarea,
    a[href],
    [tabindex]:not([tabindex='-1']),
    [role='button'],
    [role='switch'],
    [role='checkbox'],
    [role='link']
  ):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

Adding the `dialog-panel` class on the panel element in `Dialog.tsx`
makes the rule portable to portaled and non-portaled mounts alike. The
selector list mirrors the spec's enumeration of interactive elements so
custom widgets (toggles, icon buttons, etc.) pick up the indicator.

## DiffViewerDialog visually hidden title

`DiffViewerDialog` currently has no heading. The spec mandates a clip /
sr-only pattern so the heading is in the accessibility tree but
invisible. The repo does not currently ship an `.sr-only` utility; the
implementation should add one alongside the focus-visible rule:

```css
.dialog-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
```

Naming it `.dialog-sr-only` (rather than the more common `.sr-only`)
keeps the new utility scoped to this proposal so it cannot collide with
a future general-purpose visually-hidden helper.

## `describedBy` usage guidance

`describedBy` is optional per the spec; this section is **advisory**
only and does not bind implementations. The guidance below describes
the editorial choice the initial implementation should make:

- `ConfirmDialog` — pass `describedBy` when `message` is non-empty.
- `MergeDialog` — pass `describedBy`; the merge-destination paragraph
  is a natural description.
- `SettingsDialog`, `HelpDialog` — do not pass `describedBy`; they have
  sectioned content with multiple sub-headings, and pointing the
  description at one section misleads the user.
- `NewTaskDialog`, `DiffViewerDialog` — same; do not pass.

A future change can revisit any of these without violating the spec,
which only requires `describedBy` to be optional and to render correctly
when supplied.

## Test surface

Tests assert structure only. jsdom does not run accessible-name
computation, so a green test does **not** prove a screen reader will
announce the title — only that the markup is shaped correctly.
Manual verification with VoiceOver / NVDA is recommended for at least
one dialog per category before this proposal is archived.

## Out of scope

- Live regions for dialog state changes (e.g. "saved", "error").
- Reduced-motion handling for dialog open/close animations.
- Touch / mobile screen reader testing (the app is desktop-only).
- Replacing the focus-trap implementation; the existing
  `lib/focus-trap.ts` is reused.
- A redaction or fallback `aria-label` path for future dialogs without
  a title element. This is noted as a forward-compatibility item; the
  current spec assumes every consuming dialog provides a title.
