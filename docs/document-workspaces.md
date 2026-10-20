# Document Workspaces

**A project type in Parallel Code for exploring problems in prose**

Status: experimental, behind the _Document workspaces_ switch in Settings → Experimental.
Slices 1 to 4 of the plan below are built (the loop, comparison, annotations, HTML pages).

Parallel Code already runs several agents against the same codebase and keeps the results
isolated, attributable, and comparable. Document Workspaces applies the same machine to
writing and thinking: architecture notes, specs, ADRs, research. Several agents get the
same passage and the same base version. You read the alternatives and decide what enters
the document.

```
                    ┌──────────────  Claude Code  ──────────────●  accepted
                    │                                            \
   ────────●  base ─┤                                             ●──────
                    │                                            /
                    └──────────────  Codex  ───────────────○  discarded
```

## What is built

### Using it

1. Enable _Document workspaces_ under Settings → Experimental.
2. Click **+** next to Projects. One dialog adds every kind of project: type or browse to a
   folder, and the dialog suggests **Code** for a code repository (source files or a build
   manifest) and **Documents** for anything else; **Open as** switches it. For documents, a
   new Markdown document is named after the project. Start with a spec, architecture
   decision, or design note. Existing Markdown and HTML documents can still be opened from
   the folder list. Neither has to exist: type a new name onto the end of the path and that
   folder is the project. A folder that already holds documents lists them, to open one of
   those instead. The dialog says what it will do — create the folder, `git init`, create
   the file, make the first commit — and does it on confirm. With document workspaces off,
   **+** is the plain folder picker it always was.
   A document in a code repository, or in a folder inside any repository, opens as a
   **quick edit** instead, so nothing is committed there: the workspace runs on a private
   copy in its own repository under the app's data folder (`quick-edits/`), and the copy and
   the original are kept in step both ways while the app runs (polled every 700 ms), and
   brought level again on every open, so edits made while the app was closed carry over
   from either side. When both sides changed since the last sync, the original wins; the
   copy's version is saved beside the copy's repository as `<id>.conflict-<time>.<ext>`, one file per clash.
   The app shows a notification naming that file, whether the clash is found at open or while
   the copy is open, and logs a warning. Those files stay until you delete them. A deleted original is not brought back, and
   removing the quick edit from the sidebar stops the syncing but keeps the copy, so opening the
   same file again picks up its history. Quick edits are also reachable from
   a task's canvas: the document button beside _Open in the default editor_ opens the file
   as one, and so does **Edit as document** when you right-click a Markdown or HTML path
   printed in a task's agent or shell terminal. The header marks a quick edit with a neutral **Quick edit** chip; the
   open-in-editor and file-manager buttons point at the original. Click the chip to **Move
   to its own project**: the document is copied into a folder you pick (not inside a
   repository, not a folder of code, and not over an existing file), that folder becomes
   a document project, and the quick edit is removed. The original stays where it was and
   no longer receives changes. Agents in a quick edit see only the copied document, not the
   files around the original.
3. The workspace opens as a resizable panel alongside coding tasks, defaulting to 960px. The document gets the full panel until you open the side panel.
   The side-panel icon in the header shows or hides it and remembers your choice per project; hiding keeps the agent session mounted. A manually resized width is remembered.
   The workspace has one header bar: the project name, the **Document** / **History** tabs and
   the file path come first, then the document's actions (Rewrite, Comment, Ask, zoom), then
   the window controls. Below 1100px the project name and the labels beside icons give
   way; at narrow widths the actions wrap to a second row. The Undo offer after a delete
   floats below the bar, so it never reflows it.
   **Minimize** (**−**) leaves the workspace; reopen it from the sidebar. Saved comments and
   unsaved comment drafts survive; an unsent Rewrite or Ask and the selection do not.
   Selecting another
   task leaves it open; the title-bar switcher and task navigation shortcuts include it.
   One document workspace can be open at a time; selecting another document project
   replaces the project in that panel. The header’s focus button shows the document at
   full width; click it again to return to tiling. The header has two tabs,
   **Document** and **History**; comparing
   proposals happens in a modal over either.
   The file path beside the view tabs, with a ▾, is the document switcher. It drops a filter
   field (focused), your most recent files (up to five, remembered per project, the open
   one left out) and the tree of every file of the project. Type to narrow the list to
   paths containing the text, use Up/Down and Enter to open one, or click a file. Esc or
   a click outside closes it without leaving the workspace. Ctrl+Shift+P (Cmd+Shift+P on
   macOS) opens it while the document agent's task is active. Click a relative link inside a
   document to follow it to the file (and heading) it points at. Web links open in the browser. The history, the composer and the runs
   follow the open document. Each project remembers its last successfully opened file,
   including across app restarts. **−**, the percentage reset button, and **+** scale
   Markdown, inline HTML and the sandboxed page preview from 50% to 200%. The scale is
   remembered per project and leaves the app controls and terminal unchanged.
4. Select text, or press **§** beside a heading (a button, so the keyboard reaches it), to
   pick a passage. A plain click on a block opens **Comment** on it, or on the whole
   passage when the click lands inside the picked one. The comment opens on the press; a
   drag to select text puts the still-empty comment away again. A comment does not scroll
   the passage it opens on. Double-click a block to edit its source in place (see item 8). Links, controls and an open composer keep their own behaviour. A click outside an open comment saves and closes it (an empty one just
   closes); a plain click on a block also opens the next comment there. Selection keeps normal copying available, including within one
   paragraph, and shows labeled **Rewrite**, **Comment** and **Ask** actions. With a passage selected and
   no field focused, `C` comments on it, `A` asks about it and `E` edits its block. The actions apply to the selected
   blocks; the composers show the passage as their scope. Selecting alone, with the
   mouse or Shift+arrows, never opens
   or focuses the composer. **Rewrite** in the toolbar works on the selected
   passage, or on the whole document when nothing is selected.
   The compact composer opens beside the passage only after choosing an action, without
   repeating the action switcher. A comment shows only the text field, with save feedback
   only when needed; a question shows the text field and an **Ask** button.
   There are two verbs: **Edit** (you type, see item 9) and **Rewrite** (the AI does).
   **Rewrite** is the composer's one primary action. Beside it sit two compact controls:
   **Review first / Apply directly**, and, when reviewing first, an alternatives count of
   1, 2 or 3. Review first (the default) drafts proposals; 1 is a single proposal, and 2 or
   3 start a multi-candidate run spread over the main agent first and then the other
   installed agents (never more than the per-run candidate limit). Apply directly sends the
   instruction to the interactive agent and changes the checkout immediately; proposals
   leave the document unchanged until accepted. **Options** keeps agent selection,
   fine-tuning of the candidate agents, and model/session settings. Generating proposals opens Runs; sending
   a direct instruction opens Agent. The **×** or Esc closes the composer. Draft text and
   mode survive switching to History or temporarily editing the Markdown.
   For Markdown, the toolbar's **Full width** icon lets the document use the whole pane instead
   of a reading column; the choice is remembered. HTML pages always fill the pane. Mermaid diagrams, here and in every other Markdown
   surface of the app, carry an enlarge button that opens them at the size of the window.
5. The side panel has Agent, Runs, and Comments tabs and a draggable seam. Below 800px panel width,
   it sits below the document; wider panels place it on the right with a default width
   of 360px. The stacked layout gives the document 60% of the space by default. Each
   layout remembers its own split; double-click the seam to reset it.
   Resizing and switching tasks preserve the agent session. **Agent** is the terminal a task has: the bar above it
   shows the last prompt sent, the chips switch between agents, **+** adds another one
   (as tabs by default, or side by side), and the prompt box below sends to the first
   agent. A session that exits offers **Restart**, **Resume** and a switch to another
   agent. Reopening attaches to a live process automatically. If the process has ended,
   Codex, Claude Code and Copilot open their native session picker instead of resuming
   whichever conversation in the shared folder happened to run last. Gemini and
   Antigravity start fresh; use their manual resume controls if needed. Explicit session
   IDs and custom resume arguments are preserved.
   The processes survive closing the workspace. Agent definitions, stable agent IDs,
   prompt drafts and the last prompt are saved with the task; reopening after an app
   restart uses the same safe resume flow. Instructions queued for a reopened session
   remain available for manual sending, so they cannot accidentally select a conversation
   in a picker. A Markdown path the agent prints opens in the viewer when it lies inside the
   project. The tab stays mounted behind the other two, so switching tabs keeps the
   scrollback and scroll position, and returning to it triggers the regular terminal
   fit and renderer visibility handling. The tab flags _!_ while an agent waits for an answer. **Runs** lists the one-shot runs as they finish,
   each revision or merge saying which proposals it came from. Click a ready candidate in a
   finished run to review that proposal; **View output** opens its log. Running, failed and
   already-decided candidates still open their output.
   What waits for you is also said in the document, as a compact line at the top of the
   reading column, since the panel starts collapsed: _n proposals ready · **Review**_ and
   _Agent is asking a question · **Show**_ (which opens the Agent tab). Runs that wait for a
   decision also appear as a strip over the agent. **Review** of a run with one proposal
   stays in the document: the page shows tracked changes (removed blocks struck through in
   place, added and rewritten blocks marked) under a compact bar with the proposal's summary,
   **Accept**, **Reject**, **Refine…** and **Open side by side**. Accept takes every change; a
   proposal with several changes says "n changes" and picking among them happens in the
   compare view. Escape leaves the inline review without deciding. **Review** or **Compare**
   of a run with several proposals opens the compare view over the whole window: the original
   on the left and one proposal on the right. Proposal tabs support arrow keys, Home and End,
   and preserve notes, selected changes and reading position when switching. **Show all proposals**
   restores the resizable multi-column layout. Each proposal starts with a one-line summary;
   **Reasoning and notes** expands the full rationale and your review note. Warnings remain
   visible. The original and proposal start at the same height, even with details expanded.
   **Apply proposal** (or **Apply n of m changes**) stays below the scrolling document. Apply one,
   reject all, or choose **Refine this candidate** and describe what should change. With
   two or more proposals, **Merge with agent** hands the comparing to an agent: pick the
   proposals and the agent, adjust the guidance, and it drafts one merged proposal from
   the diffs and your notes on each candidate, saying which parts came from where. The
   merged version lands in Runs like any other proposal and still needs acceptance.
   A candidate with more than one change carries a checkbox beside each
   of them: every change is kept until you clear its box, the passages you dropped recede
   in place so you can still read what you turned down, and the button then says
   **Accept n of m changes** and takes only those. **Preview result** shows the complete
   document with the selected changes applied and declined passages restored from the base.
   **Back to changes** preserves your choices. Acceptance waits for the combination to be
   verified and is disabled if it cannot be combined cleanly. Refinement uses the same agent and model in a fresh isolated run,
   starts from that candidate's content, and leaves the original proposal available.
   The revision appears in Runs and still needs acceptance.
6. **History** lists document versions and their changes. **Save version** records all
   tracked file changes in the project; **Restore last version…** confirms before discarding
   tracked changes since that version. Versions are also recorded automatically: closing
   the workspace or switching to another document commits any uncommitted tracked edits
   (after flushing the Markdown editor) without a notification; a failure is reported.
   The Markdown editor's **Saved** means written to disk. When tracked changes are not yet
   in a version, the History header says _Changed since last version_. History retains
   older-version previews, diffs, and commit reverts.
7. **Comments and questions.** A comment is a note on a passage, kept for you; a question
   is asked of an agent, which answers it beside the passage. They are separate actions:
   choose **Comment** or **Ask** beside a selected passage.
   Enter inserts a new line. Leaving the field or closing the popover saves it
   automatically, without an agent; Ctrl/Cmd+Enter saves too, and a failed save keeps the
   draft with a Retry action. A click outside the comment closes it at once and saves it
   behind; if that save fails, an error is shown and its text, with Retry, takes the
   place of the next comment; when that one has text of its own, the failed text waits
   for the comment after it (for this session). While "Saving…" or "Not saved" shows,
   the field's text makes way for it. The block toolbar stays available on hover while a comment is open; over the
   comment's own passage it switches the comment to Ask or Rewrite and keeps the text. The **Ask** composer is never autosaved: **Ask** or
   Enter (Shift+Enter for a new line), like Rewrite, saves the question and asks the agent (a picker appears when more than
   one is installed). The **Comments**
   tab lists the current document's comments, with passage quotes and a Show resolved
   filter; clicking an entry returns to its passage. The bubble has no title bar: its icon
   buttons (Edit, Resolve, **Rewrite from this**,
   Delete) sit beside the text. Edit opens an explicit editor with Save and Cancel; failed
   saves retain the text. Comments remain in margin markers, available by hover, keyboard
   focus, or click.
   A question is answered by an agent running read-only in the checkout; while it works the
   bubble says _Waiting for <agent>…_, and question and answer stay visible together.
   **Ask follow-up** under an answer continues the conversation with the agent
   that answered: the follow-up is a new question on the same passage, and the agent is
   handed the earlier exchange along with it. Resolve (`r`) collapses a bubble to one
   line, Delete removes it with an Undo
   in the toolbar (several quick deletes come back one per Undo), and **Rewrite from this** reopens the composer on the passage with the
   bubble's text (and answer) as the instruction; the bubble then collapses as `task`.

8. **Edit a block.** Double-click a block to edit its source. In Markdown the source
   replaces the block in place, in the same live editor as **Edit**: **Save block** or Ctrl+Enter saves, Escape or **Cancel**
   discards (asking first once edited), and a click elsewhere puts away an untouched editor. An edited one stays,
   also through a reload of the document, until it is saved or discarded. In
   an HTML document the source opens in a dialog. If the document changes so that the
   block is gone, an edited editor moves to that dialog, where saving reports the change
   and Cancel discards; an untouched one just closes. Saving updates the
   document directly. Surrounding content and line endings are preserved. If the file
   changed meanwhile, saving refuses to overwrite it and keeps your text available to copy.
   Edits made this way, or in an outside editor, are recorded as a version automatically
   or with **Save version** in History, or discarded with **Restore last version…**. Next
   to the editor button, a folder button opens the project in the file manager. To edit a
   whole Markdown document, see the next item.

9. **Edit Markdown directly.** For `.md` and `.markdown` files, choose **Edit** in the
   document toolbar. With a passage selected, the cursor lands at the start of its first
   line. The live Markdown editor saves after a 1.5-second pause;
   **Save** or Cmd/Ctrl+S saves immediately. Undo and redo remain available across
   saves and switching between **Edit** and **Preview**. Preview keeps the rendered
   diagrams, annotations and passage actions. Switching to Preview, History or a
   proposal comparison saves first; a failed save keeps the editor open.
   Unsaved drafts are backed up in local app storage and restored when you reopen
   their document, including after switching files or closing the workspace. Reopening
   waits for an outstanding save so subsequent typing and undo remain recoverable. If an
   agent or external editor changes the file while a draft is unsaved, the draft is
   preserved and saving refuses to overwrite the changed file; the status row says so.
   Copy the draft before choosing **Reload from disk**, which asks again
   (**Discard my draft?**) before throwing it away. HTML retains its existing block editor.

### How it works

- **Editing happens in the Markdown editor, block editor, your editor, or interactive session.** The app
  watches the open file and re-renders; an external change drops any active selection. The Agent
  tab is a task's AI terminal and prompt box (`TaskAITerminal`, `PromptInput`) over a hidden
  task per project, id `doc-agent-<project>`, kept out of the coding task list but saved
  with the regular task state. Its first agent's pty carries the same id, so reopening the
  workspace re-attaches; after an app restart it uses a session picker where supported.
  See the provider references for [Codex](https://developers.openai.com/codex/cli/reference/),
  [Claude Code](https://code.claude.com/docs/en/cli-reference), and
  [Copilot](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference).
  [Gemini's CLI resume flag selects the latest session](https://geminicli.com/docs/cli/tutorials/session-management/),
  so document terminals leave resuming to its interactive `/resume` command instead.
  Each time
  the workspace mounts, the agents are re-armed to attach (a restart clears that for its
  one spawn), and an exited agent is reset for resuming. Removing the project
  kills the sessions. A scoped instruction, _your words, then Document, Scope and the
  passage verbatim_, goes to the selected agent as a prompt: typed straight in when the agent looks
  idle (quiet output, no open question, and for Claude no hook turn in flight), else
  queued as the task's initial prompt, which the prompt box sends once the agent is
  ready; a second instruction is refused while one waits. Reopened sessions require an
  explicit send from the prompt box; further instructions cannot replace an existing draft.
  Hidden document-task drafts participate in debounced autosave. Relinking a document
  project stops its old terminals before changing their working folder, keeping drafts;
  restoration also derives the folder from the current project path. Because the agent edits the
  checkout directly, its work is committed as `Manual edits` by the next one-shot
  dispatch rather than as a proposal to compare.
- **Every file of the project is one click away.** The file tree is `git ls-files`
  (tracked and untracked, ignores respected) minus `.parallel/`, `.worktrees/` and `.git/`,
  capped at 5,000 entries, refreshed on every new head. Opening a file swaps the watcher
  and the snapshot; annotations are filtered to the open file's path, and runs against
  other documents say which. Links resolve against the open document's folder, never
  above the project root.
- **Output is kept.** Each candidate's readable log is appended to
  `.parallel/logs/<run>/<candidate>.log` as it streams (the rail shows the tail); the
  folder is git-excluded through `.git/info/exclude`. The output dialog reads it back,
  capped at the last 2 MB, and re-reads every second while the candidate runs.
- **Dispatch commits pending edits first** as a plain `Manual edits` commit so every run
  has a real base. Only tracked files count as pending edits: untracked scratch files
  and everything under `.parallel/` stay out of that commit.
- **Headless agents.** Each candidate runs the official CLI in print mode inside its own
  worktree under `.worktrees/parallel-doc/`: `claude -p --output-format stream-json`
  with tools limited to Read/Edit/Write/Glob/Grep, `codex exec --json --sandbox
workspace-write` (the sandbox blocks writes outside the worktree),
  `gemini -p --output-format json --approval-mode auto_edit` (`plan`, Gemini's read-only
  mode, for annotation questions). Process exit means the
  proposal is ready. Cancelling kills the CLI's whole process group. OpenCode and Copilot
  expose an unrestricted shell in print mode and are not offered until they can be
  restricted. A model or reasoning level chosen in the composer goes to the CLI as
  `claude --model … --effort …`, `codex --model … -c model_reasoning_effort=…` or
  `gemini --model …`, is kept on the candidate in the run record, and lands in the
  `Parallel-Model` and `Parallel-Effort` trailers of the proposal and integration commits.
- **The main session stays warm.** One agent owns the project's main session (choose it in
  the composer). Its worktree is persistent (`.worktrees/parallel-doc-main`) so the working
  directory, and with it the provider's prompt cache, never changes; each run resumes the
  session by id (`claude --resume`, `codex exec resume`). After the canonical document
  moves, the next prompt to that session carries the diff since it last saw the file.
  Other agents, and extra candidates from the main agent, are one-shot alternates. While
  the main session is working, a new run can only use alternates.
- **Scope is enforced, not trusted.** Files the agent touched or staged outside the
  document are reverted before the proposal commit and listed on the candidate; the
  proposal commit is verified to contain the document alone. Hunks inside the document
  but outside the selected passage are counted and flagged.
- **Structured rationale.** Every prompt asks the agent to end with a JSON block:
  summary, changes, assumptions, questions, warnings. It opens each candidate in the
  compare view and becomes the commit message.
- **One proposal commit per candidate** on a `parallel-doc/<run>-<label>` branch, carrying
  `Parallel-Run`, `Parallel-Agent`, `Parallel-Candidate`, `Parallel-Scope` and
  `Parallel-Base` trailers.
- **Refinement keeps the canonical base.** A new isolated worktree starts at the original
  run's base, then receives the selected candidate's document before the agent starts.
  The new proposal therefore includes both the original changes and the refinement;
  accepting it uses the existing three-way integration. The run records its source run
  and candidate in `refinement`. Refinement covers the whole proposal because passage
  line numbers may have changed. Dispatch does not commit pending canonical edits.
- **Merging is a run like any other.** One fresh candidate starts at the source run's
  base, the same content every proposal saw, and its prompt carries each chosen proposal
  as a diff against that base, with the candidate's own summary and the reviewer's note.
  The run records `merge` (source run and candidate ids), covers the whole document, and
  never resumes the main session, so a warm session is not moved onto unaccepted content.
  Refining and merging are mutually exclusive on one run.
- **Follow-up questions form a thread.** A follow-up is a new annotation with
  `followUpOf` pointing at the answered question. Asking it walks that chain (bounded,
  and safe against a loop in a hand-edited file) and puts the earlier questions and
  answers into the read-only prompt ahead of the new one.
- **Acceptance is one squashed integration commit** on the checked-out branch, containing
  the document and the run record `.parallel/runs/<id>.json`. A proposal whose base is
  behind HEAD is merged three-way on acceptance and marked stale if it no longer applies.
- **Partial acceptance composes rather than merges.** Changes are grouped into hunks — a
  run of base blocks and the run of candidate blocks replacing it, so an insertion has no
  base blocks and a deletion no candidate ones. The renderer splices the base and the
  candidate at their recorded block offsets, verifying each block still matches the text
  those offsets describe, and sends the result as content; the commit carries a
  `Parallel-Partial: n/m changes` trailer and the run records the counts. Splicing text is
  not the same as splicing structure — markdown separates blocks by a blank line but not
  always by two newlines, so a heading and its paragraph sit on consecutive lines — so each
  seam of a spliced passage is opened to a blank line and the result is parsed back and
  compared, block for block, against the passages the reader picked. A composition that
  does not re-read as those blocks is refused rather than written. Because the composition
  is made from the base, it is written only while the document itself has not moved since;
  otherwise the run is marked stale, as a hand-picked mix has no side for a three-way merge
  to take each declined passage from. Main verifies as well as trusts: it re-reads the base
  and the candidate from their commits and refuses content that is not a mix of the two, so
  a composition the renderer got wrong cannot reach the file. Two removals can want the same
  checkbox — the last block of a document takes every deletion that ends it — so a block
  carries a stack of them rather than dropping the second and leaving a change nobody can
  decline. Keeping every change is still the ordinary git path, untouched. HTML pages are
  accepted whole: their blocks are elements of a parsed page, not spans the composer can
  splice back together.
  Rejection commits the run record alone, so the history view (which excludes `.parallel/`)
  never shows it. Reverting from the history view undoes a commit's content and keeps the
  run records, with a `Parallel-Revert` trailer.
- **Run records are checked on load.** They travel with the repository, so a clone can
  carry records written elsewhere. Worktree paths, branch names and commit hashes are
  validated against what this app would have produced before they reach git or the
  filesystem; a record that fails is ignored.
- **Compare view** renders base and candidates with the same renderer, marks changed,
  added and removed blocks at block granularity, navigates by changed block, and hides
  agent identity until you toggle _Show agents_. _Source diff_ swaps the rendering for the
  unified diff. Each candidate has a free-text note stored in the run record.
- **Anchors stay out of the prose.** An annotation records path, base commit, lines, the
  exact quote, the neighbouring text and the nearest heading in
  `.parallel/annotations.json` (`version: 1`). On every version the app relocates it by
  quote; failing that — the normal case here, since an accepted proposal rewords the very
  passage a note hangs on — by similarity, a Sørensen–Dice score over word bigrams, with
  neighbours, heading and the recorded lines breaking ties. The two recorded neighbours also
  bracket where the passage can be: a candidate reaching the block that followed the note
  has passed its end, one reaching back to the block that preceded it has not arrived at its
  start, and either way it is the section next door rather than the passage. That is what
  keeps a note detached when its own section is dropped and a sibling worded almost the same
  survives — and what lets the note follow its passage when the two sections swap places. A passage too unlike the quote, or no further ahead than an unrelated one, shows
  as **detached** rather than being attached to the wrong place. Annotations are committed
  along with the next content or metadata commit, never on their own.
- **Run records are versioned** (`version: 1`) so a format change is a migration.
- **Setup is part of the feature.** Creating a project runs whatever is missing — the
  folder, `git init`, the starter document, the first commit — so the workspace never opens
  on a folder its own dispatch would reject. Every step is skipped when it is already true,
  and the commit takes the document alone, leaving anything you had staged staged.
- **HTML pages are worked on as pages.** A document that starts with a doctype or `<html>`
  is parsed with parse5 and rendered inline as itself: the body's markup stays whole, so
  its own layout holds, and the innermost block-level elements (a paragraph, a heading, a
  list, a table; not the `<main>` or `<div>` around them) are marked as the blocks. The
  page's stylesheet comes along, scoped to the viewer with `@scope`, `html`/`body` rules
  pointed at the page root, the app's annotation markers kept out of it, scripts and
  `@import` dropped. The block toolbar and an open note are not inside the page at all:
  they float over the window, placed from the block's on-screen position and moved with
  it on scroll, so a page element that clips its overflow cannot trap them and nothing
  in the workspace, the composer included, paints over them. The markdown viewer uses
  the same two overlays. Every block carries its source lines, so selection, the composer,
  annotations, compare marking and history work on the rendered page exactly as on
  Markdown; marks are outlines and markers hang out of the page's flow, so nothing the
  app adds moves the page's own elements. Scripts and external stylesheets do not run
  in this view; open the file in a browser to see them.
- **It lives in two folders.** `electron/documents/` holds the runs, agents, prompts,
  annotations, setup, IPC shapes and the registrar for every channel it owns;
  `src/documents/` holds the UI with its store, types and markdown helpers. The seams are
  `registerDocumentHandlers(win)` and `stopAllDocumentWork()` in main,
  `<DocumentWorkspacePanel />` in `TilingLayout.tsx`, and the sidebar's project row and `+` menu.
  The one runtime module the renderer imports across the process boundary is
  `electron/documents/shared.ts`.

### How well does parallel work function without conflicts?

Proposal runs isolate their edits in separate worktrees. Dispatch, candidate completion,
manual block saves and acceptance serialize app-managed Git changes per project. The warm
main proposal session accepts one run at a time; alternates can run concurrently.

The integration test starts three revisions from the same base. Two change different
passages and are accepted concurrently: both edits survive. The third rewrites an already
changed passage: acceptance refuses it, marks it stale and leaves the accepted document
intact, with no unresolved Git conflicts. Existing tests also check that later manual edits
survive a conflicting acceptance. This verifies the Git mechanics with local fake agents;
it does not measure the quality or semantic compatibility of real agents' prose.

Interactive terminals are different: all agents in the document workspace edit the same
checkout, and their filesystem writes do not acquire the app's project lock. Two agents
editing the same passage can overwrite each other, including while acceptance is underway.
Use isolated proposals for concurrent revisions of the same document, or give interactive
agents separate files and wait for their edits to finish before accepting proposals. A clean
Git merge still needs review for contradictions and duplicated ideas. Partial acceptance
requires the document itself to be unchanged since the proposal's base.

### Not in this slice

Evaluator agents, threaded annotations, rich-text editing,
external stylesheets and images in HTML pages. Custom agents, OpenCode and
Copilot cannot be picked. Gemini runs one-shot only. Non-document files open in the viewer
as Markdown, so a source file renders as prose rather than as code. The interactive
session's edits are not proposals: they are not compared, and the compare view never sees
them.

---

## The plan

### The constraint that shapes the compare view

**Restructuring is the normal case, not the edge case.** Agents rewrite whole paragraphs by
default, so line diffs on prose are noise from the first day. The cheap answer is not
semantic diffing. It is requiring every proposal to return a structured account of itself:
what changed, why, what it assumed, what it could not resolve.

### Core concepts

- **Document project.** A Git repository holding one or more related documents plus
  sources, assets, annotations, and run metadata under `.parallel/`.
- **Canonical document.** The checked-out branch is the state you see. No agent changes it
  except through an explicit acceptance action. You change it whenever you like.
- **Scope.** Every task carries an explicit scope: a selection, a section, a document, the
  project. Scope is a guardrail; out-of-scope changes are flagged rather than trusted away.
- **Main session and alternates.** One long-lived main session per project holds context
  and is the default target. Other agents spawn alternates from the same base for one task.
  The main session has no special write rights, and after every accepted change it is
  handed the resulting diff.
- **Proposal.** A Git-backed result carrying its base commit, agent, instruction, scope,
  resulting commit, structured rationale, and open questions. A proposal whose base is no
  longer HEAD is stale.

### The loop

1. Open a document project. 2. Read the rendered document. 3. Select a passage, section,
   or document. 4. Write an instruction. 5. Pick agents. 6. Each candidate gets a worktree from
   the same base. 7. Agents return a proposal with rationale and questions. 8. Compare against
   the base and each other. 9. Accept one, refine, or reject everything. 10. The result lands as
   one readable commit, revertible through Git.

### Compare view

Judged on time-to-decision, not on how much it displays. Rationale first, rendered
candidates side by side, changed blocks marked at block granularity, source diff as a
toggle, navigation by changed passage, model-blind by default.

### Git and history

Git holds the content; Parallel Code adds provenance a person can read. One worktree and
branch per candidate, one proposal commit per result, one squashed integration commit per
acceptance, run metadata under `.parallel/runs/`. The history view is derived from Git plus
run records at read time. No separate event log.

### Security model

Official CLI processes, so subscriptions and local config keep working. Repositories,
prompts and diffs stay local except where the chosen provider receives them. Modifying
tasks run in isolated worktrees with explicit scopes and no shell tools. Nothing is
integrated without an explicit acceptance.

### After this slice

Further HTML work, research roles and evaluator agents are deferred until the Markdown
selection → proposals → comparison → acceptance loop proves useful in real writing tasks.
The items below are possibilities, not commitments for the next iteration.

1. Annotations: bubbles on anchors, agent-answered questions, single-keypress dismissal.
2. HTML: the page rendered inline as element blocks with source mapping.
3. Durable anchors and selective integration; research projects with sources and roles;
   semantic comparison by claim and decision.

### Kill criteria

Judging candidates takes longer than writing the passage yourself, or you find yourself
accepting the first candidate without reading the rest. Either means the comparison loop
does not hold for prose, and the answer is to stop rather than to add roles, formats, or
evaluator agents.
