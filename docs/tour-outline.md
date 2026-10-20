# Tour outline: slide cards, nested answers and saved tours

Builds on [guided-understanding-plan.md](guided-understanding-plan.md) and
[tour-polish-plan.md](tour-polish-plan.md). Goal: a quick overview of a subject
that the reader can dive in and out of, keep, and hand to the agent.

## What the reader sees

- **Slide cards.** Plan, document and agent (concept) tours write each card as a
  slide: the title is the claim, two to five short points back it, and any prose
  sits in collapsed **Notes**. Comparison and flow cards keep their visual with a
  one-line caption. File tours and change tours keep prose bodies; code tours are
  to be evaluated separately.
- **Answers are cards.** Ask, Go deeper, a suggested question, or the `›` on a
  single point adds the answer as child cards of the card on screen, at any depth
  up to five levels, and opens the first one. The answers stack below the card
  they answer, which moves up as the reader goes down into them; the card on
  screen slides to the middle, and the cards around it stay dimmed until clicked.
  A line above an answer names the question and leads back to the card it
  answers; an answer lists its own answers at its foot.
- **Outline.** Where the window is at least 960px wide, a quiet tree of every
  card title stands to the right of the card. The path to the card on screen is
  open; other branches open from their twisty. On narrower windows the list icon
  shows the same tree in the card's place.
- **Keys.** ← and → move between the tour's own cards, from an answer too. ↓
  reads on through the answers under a tour card, into each card's answers first,
  and after the last one goes to the ask field; ↑ steps back to the answer above
  or out to the card answered, and from the ask field back to the cards. Home and
  End jump to the first and last tour card. Enter, from Next or the card, goes to
  the ask field.
- **Where an answer sits.** The line above an answer also says which of the
  answers to its question it is, such as "Answer 2 of 3". A question still being
  answered stays visible from any card: the ask field names the card it was asked
  on, and Cancel stops it.
- **Limits.** Answers nest five levels deep, and a tour stops taking questions
  before an answer could take it past the 200 cards or 512 KB a saved file may
  hold. The ask field then says which limit was reached, and Go deeper gives way
  to **Continue in chat**, which references the card in the agent chat.

## Saving and reopening

**Save tour** (save icon) writes the tour, with every answer, to
`<subject>.tour.md` at the root of the task's worktree. A first save never
overwrites: an existing file of that name moves the tour to `-2`, `-3` and so on.
After that, each new answer updates the same file. In place of the icon, a quiet
line says **Saving…**, **Saved · name** (press it to open the file on the
canvas) or, when an update failed, **Not saved · Retry**, which writes the
answers the file is missing. The file is an ordinary
untracked file: commit it to keep it with the branch, or it goes when the
worktree is removed.

Open a `.tour.md` file on the canvas and press **Open Tour**: it opens as a tour
straight away, with no provider call, and follow-ups replay the plan, document or
file it names as its source (or the cards themselves when that is gone). A
reopened file is a tour of its own: it never replaces a tour generated from the
same document, so answers not yet saved there are kept. That holds for a file
saved a moment ago too, and reopening reads the plan, document or file afresh, so
a follow-up replays it as it reads now. It is the file's record,
so it offers no Rework or Regenerate; the document's own **Take Tour** makes a
new tour.

### File format

```text
---
parallel-code-tour: 1
kind: document
subject: "docs/cache.md"
source: "docs/cache.md"
---

# docs/cache.md

## Reads dominate

<!-- tour-card {"tone":"important","fields":["label","points","notes"]} -->
**KEY DECISION**

- 90% of calls are reads
- Cache hits skip the database

<details><summary>Notes</summary>

Measured over the last week.

</details>

### Hits are measured weekly

<!-- tour-card {"question":"How do we know?","fields":["label","points"]} -->
...
```

Each card is a heading one level below its parent's, so the file reads as an
outline on GitHub and can be edited by hand or by the agent. The HTML comment
carries what Markdown cannot show: tone, form, the question a card answers,
suggested questions, and `fields`, the blocks the card has. With `fields` each
block is read only from where the writer puts it, so a table, a text fence or a
list in a prose body stays body. A card without the comment is read loosely: a
list is its points, a two-column table its comparison, a text fence its
diagram, and a heading alone is a valid card. Card text never starts a heading
of its own (such lines are written as `\#`) and never leaves a fence open.

Edits made to the file outside the tour are never overwritten, and a removed
file is not brought back. When the next answer would replace a file that changed
or went away since the tour last wrote or read it, the tour lets go of the file
and says so, and drops any updates queued behind that one; open the file again,
or save the tour as a new file. Every replacing write names the text it expects
to find, and the backend refuses one that does not.

## Referencing a card in the chat

**Reference in chat** (@ icon) closes the tour and appends the card on screen to
the task's prompt draft: the tour, the titles above it, the question it answers,
its content and, when saved, the file to read for the rest. Nothing is sent until
the user sends it. Reopening the tour keeps the reader's place.

## Where it lives

| Concern                       | Module                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| Slide fields and validation   | `src/lib/understanding-tour.ts`, caps in `electron/shared/understanding-limits.ts`   |
| Slide prompt rules            | `src/lib/understanding-prompt.ts`, `tour_publish` in `electron/mcp/mcp-tool-list.ts` |
| Tree and reading order        | `src/lib/tour-tree.ts`                                                               |
| Tree state, save, restore     | `src/lib/create-understanding-tour.ts`                                               |
| Markdown file and chat format | `src/lib/tour-file.ts`                                                               |
| Writing into the worktree     | `electron/ipc/tour-files.ts` (`SaveTourFile`)                                        |
| Viewer                        | `src/components/UnderstandingTourDialog.tsx`, `src/components/understanding/`        |

`SaveTourFile` only writes `.tour.md` files, only into folders whose real path is
inside the worktree, never through a symlink, and never into `.git` or the app's
folders.

## Not done yet

- Editing cards or the outline in the app; the saved file can be edited instead.
- Letting the agent add answers under a given card through MCP.
- Showing two cards side by side.
- Reloading an open tour when its file changes on disk; reopening it reads the
  file again.
