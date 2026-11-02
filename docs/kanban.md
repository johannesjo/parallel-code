# Project plan

Each code project can have a plan: a Kanban board of planned work, opened
from the checklist icon on the project's row in the sidebar (next to the
GitHub icon). It is separate from the Board view of running Parallel Code
tasks, which uses a lanes icon. The plan is a plain Markdown file,
`KANBAN.md`, in the project root: edit it in the app, in any editor, or let an
agent write it. The plan follows changes on disk within a couple of seconds.

## On the plan

- The plan opens inside the Board view, in place of the running tasks, with the
  same lanes, cards and keys. **Running tasks** in the title bar, or Esc, shows
  the running tasks of this project only (it sets the sidebar's project
  filter). While the running tasks are filtered to a project, the title bar
  names it, with **×** to show all projects and **Plan** to come back. A card
  is a plan item; the tasks started from it are listed on the card.
- The title bar's filter searches the cards. **Needs you N** shows only cards
  whose task needs input or failed; it stays hidden while none do.
- The ⋯ menu holds **Open file**, **Reload** and **Keyboard shortcuts** (`?`).
- A task opened from a card shows in the board's side panel. The planning
  agent and that task take turns there.

## File format

<!-- prettier-ignore -->
```markdown
# Offline sync

Optional notes about the plan.

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
  is never read as plan structure.
- Column names decide automation: the first "In progress"/"Doing" column is
  where started cards go, "Review"/"QA" where finished ones go, "Done" where
  merged ones go, and "Archive" is collapsed by default.

## Working with tasks

- The play button in a card's corner, shown on hover or focus (or `s`), opens
  the new-task form prefilled from the card; nothing is sent until you create
  the task. A card that already has a task starts another one the same way. Card text comes from a file
  in the repository, so control and invisible characters are removed from the
  prompt.
- Once a worktree task exists, its branch is recorded under the card and the
  card moves to In progress. Direct-mode tasks share the base branch and are
  not linked.
- The card then lists each task by name with its state (working, needs input,
  failed, ready for review), one line of agent activity (its branch until the
  agent reports) and the PR checks. Only needs input
  and failures are coloured; **Answer** jumps to the waiting agent pane.
- A card moves forward on its own, never backwards: to Review when the agent
  finishes with its work committed (the task shows Ready), signals done or
  opens a PR, to Done when the branch is merged from the app,
  the task lands, or its PR merges on GitHub. Closing a task checks its card
  off too, unless another task of the card is still open.
- Merging is not blocked by the plan. Unstaged edits to `KANBAN.md` are set
  aside before a merge and written back afterwards, whatever the merge does;
  if the task's branch changed the plan too, the local plan wins and the
  merged version stays in the commit. Staged plan changes still block a
  merge, like any other uncommitted change.

## Planning agent

**Plan with agent** opens a separate hidden agent session (not the GitHub
page's) in the project checkout, with a planning prompt in its prompt box. It
edits `KANBAN.md` directly and the plan highlights the cards that changed.
An unsent draft in its prompt box is never replaced, and an open new-task
draft has to be created or closed before the planner takes its place.

## GitHub issues

- **Add from GitHub** on the plan picks open issues and pull requests; each
  becomes a card with an `issue:` line. Only the title is copied: the issue
  body stays on GitHub, where a task started from the card reads it.
- On the GitHub page, **Add to plan** adds the open issue (or the selected
  batch); an issue already on the plan shows its column instead.
- A task started from an issue card is linked to the issue like one started
  from the GitHub page, and its prompt asks for "Fixes #N" in commits and the PR.
- Nothing is written to GitHub automatically.

## Safety

- The main process reads and writes only `KANBAN.md` in the project's real
  root, refuses symlinks, FIFOs, files over 1 MB and files that are not valid
  UTF-8, and writes atomically.
- Every write names the text it expects to replace. The plan re-applies the
  user's change to the file as it is on disk when another writer (an editor,
  the planning agent, the automation) got there first, so edits are not lost.

## Code

- `src/lib/kanban.ts`: parser, serializer and pure plan operations.
- `src/store/kanban.ts`: file access, task linking, automation, GitHub helpers.
- `src/components/KanbanPage.tsx`, `KanbanCard.tsx`, `kanban.css`: the page.
- `src/components/board/`: lanes, rails and task status shared with the running-tasks
  board.
- `electron/ipc/kanban.ts`: the main-process file access.
