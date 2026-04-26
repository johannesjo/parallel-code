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
- Generate a fallback title id via Solid's `createUniqueId()` when the
  consumer does not supply one. Apply that id to the rendered `<h2>`.
- Forward whichever id is in effect (consumer-supplied or generated) to
  `Dialog` as `labelledBy`, and forward `describedBy` if the consumer
  passes one.

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
.dialog-panel :is(button, input, select, textarea):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

Adding the `dialog-panel` class on the panel element in `Dialog.tsx`
makes the rule portable to portaled and non-portaled mounts alike.

## `describedBy` usage guidance

`describedBy` should be supplied when the dialog has a meaningful body
lead — typically a one-paragraph explanation under the title:

- `ConfirmDialog` — yes, when `message` is non-empty.
- `MergeDialog` — yes, the merge-destination paragraph is a natural
  description.
- `SettingsDialog`, `HelpDialog` — no, they have sectioned content with
  multiple sub-headings; pointing `describedBy` at one section misleads
  the user.
- `NewTaskDialog`, `DiffViewerDialog` — no for the same reason.

This guidance lives here, not in the spec, because it is a styling /
content-pattern call rather than a normative requirement.

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
