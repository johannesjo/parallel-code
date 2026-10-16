# Project Kanban board

Each code project can have a Kanban board, opened from the board icon on the
project's row in the sidebar (next to the GitHub icon). The board is a plain
Markdown file, `KANBAN.md`, in the project root: edit it on the board, in any
editor, or let an agent write it. The board follows changes on disk within a
couple of seconds.

## File format

<!-- prettier-ignore -->
```markdown
# Offline sync

Optional notes about the board.

## Backlog

- [ ] Conflict resolution UI
  Show both versions side by side and let the user pick.
  - [ ] Diff view for text fields
  depends: Sync engine
  issue: https://github.com/acme/app/issues/12

## In progress

- [ ] Sync engine
  branch: `task/sync-engine`

## Done

- [x] Spike: evaluate CRDT libraries
```

- `##` headings are columns; top-level list items are cards; `- [x]` marks a card done.
- Lines indented under a card are its description (Markdown). `- [ ]` items in
  it are the card's checklist, shown with progress on the card and given to a
  task as acceptance criteria.
- `depends: <card title>` marks the card blocked until that card is done.
- `issue: <github.com URL>` links a GitHub issue or pull request.
- `` branch: `name` `` is written by the app when a task is started from the card.
- Anything else in a column (paragraphs, sub-headings, comments, code) is kept
  where it is. Obsidian Kanban's front matter and settings block are kept too,
  as are the file's line endings and byte-order mark. The parser follows
  CommonMark for code fences, HTML comments and list items, so text inside them
  is never read as board structure.
- Column names decide automation: the first "In progress"/"Doing" column is
  where started cards go, "Review"/"QA" where finished ones go, "Done" where
  merged ones go, and "Archive" is collapsed by default.

## Working with tasks

- **Start task** on a card (or `s`) opens the new-task form prefilled from the
  card; nothing is sent until you create the task. Card text comes from a file
  in the repository, so control and invisible characters are removed from the
  prompt.
- Once a worktree task exists, its branch is recorded under the card and the
  card moves to In progress. Direct-mode tasks share the base branch and are
  not linked.
- The card then shows the task's state (working, needs input, failed, ready
  for review), one line of agent activity and the PR checks. Only needs input
  and failures are coloured; **Answer** jumps to the waiting agent pane.
- A card moves forward on its own, never backwards: to Review when the agent
  signals done or opens a PR, to Done when the branch is merged from the app,
  the task lands, or its PR merges on GitHub.
- Merging is not blocked by the board. Unstaged edits to `KANBAN.md` are set
  aside before a merge and written back afterwards, whatever the merge does;
  if the task's branch changed the board too, the local board wins and the
  merged version stays in the commit. Staged board changes still block a
  merge, like any other uncommitted change.

## Planning agent

**Plan with agent** opens a separate hidden agent session (not the GitHub
page's) in the project checkout, with a planning prompt in its prompt box. It
edits `KANBAN.md` directly and the board highlights the cards that changed.
An unsent draft in its prompt box is never replaced.

## GitHub issues

- **Add from GitHub** on the board picks open issues and pull requests; each
  becomes a card with an `issue:` line. Only the title is copied: the issue
  body stays on GitHub, where a task started from the card reads it.
- On the GitHub page, **Add to board** adds the open issue (or the selected
  batch); an issue already on the board shows its column instead.
- A task started from an issue card is linked to the issue like one started
  from the GitHub page, and its prompt asks for "Fixes #N" in commits and the PR.
- Nothing is written to GitHub automatically.

## Safety

- The main process reads and writes only `KANBAN.md` in the project's real
  root, refuses symlinks, FIFOs, files over 1 MB and files that are not valid
  UTF-8, and writes atomically.
- Every write names the text it expects to replace. The board re-applies the
  user's change to the file as it is on disk when another writer (an editor,
  the planning agent, the automation) got there first, so edits are not lost.

## Code

- `src/lib/kanban.ts`: parser, serializer and pure board operations.
- `src/store/kanban.ts`: file access, task linking, automation, GitHub helpers.
- `src/components/KanbanPage.tsx`, `KanbanCard.tsx`, `kanban.css`: the page.
- `electron/ipc/kanban.ts`: the main-process file access.
