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
2. Click **+** next to Projects and choose **Document project…**. Type or browse to a
   folder and name the project; a new Markdown document is named after it. Start with a
   spec, architecture decision, or design note. Existing Markdown and HTML documents can
   still be opened from the folder list. Neither has to exist: type a new name onto
   the end of the path and that folder is the project. A folder that already holds
   documents lists them, to open one of those instead. The dialog says what it will do —
   create the folder, `git init`, create the file, make the first commit — and does it on
   confirm.
3. The workspace opens full-window with two tabs, **Document** and **History**; comparing
   proposals happens in a modal over either.
   A **Files** tab in the right panel lists every file of the project; click one to open
   it, and click a relative link inside a document to follow it to the file (and heading)
   it points at. Web links open in the browser. The history, the composer and the runs
   follow the open document.
4. The composer is a popover over the prose, never inside it, and stays out of the way
   until there is something to compose: select text, click a block, or press **§** next
   to a heading to open it on a passage, or choose **Revise document** in the toolbar to
   open it on the whole document. On a passage it sits right under it (above it when the
   foot is close), at full strength and with the cursor in it, and follows the passage as
   you scroll. It steps back once you leave it. Type an instruction and press Enter. Hovering a
   block shows five icons in the gap just above it, clear of the prose so a click meant
   for the passage cannot land on one, each named as you point at it: task, proposals,
   note and ask pick the block and open the composer on that mode (its tabs carry the same
   icons), and the pencil, set apart, opens the block's source for editing. The picked
   block's icons step aside while the composer is up on it; the other blocks keep theirs,
   so one click moves the composer to another block. The **×** in the composer's corner,
   or Esc, lets go of the passage and closes the composer.
   The composer's four tabs are the four things one does with a passage; **Edit with agent** and
   **Proposals** are the same instruction sent two ways:
   - **Edit with agent** types it into the long-running agent session on the right, which
     works in the checkout as you watch. Its edits show up in the viewer as they land and
     are committed as `Manual edits` before the next one-shot run.
   - **Proposals**, the default for a new composer, runs headless candidates in their own worktrees. The agents sit in
     plain view: click one to add or drop it, and its count to have it draft more than
     once; a counter says how many of the allowed candidates are in play. **Models and
     main session** folds away the tuning: each candidate gets a **Model** field and, where
     the CLI has one, a **Reasoning** level, so one agent can run its main session on one
     model and an alternate on another; both are the CLI's defaults until you choose, and
     the choice is remembered per project, agent and candidate.
     The toolbar's **Full width** lets the document use the whole pane instead of a reading
     column; the choice is remembered. Mermaid diagrams, here and in every other Markdown
     surface of the app, carry an enlarge button that opens them at the size of the window.
5. The right-hand panel has three tabs and a draggable seam (double-click it to reset the
   width; the width is remembered). **Agent** is the terminal a task has: the bar above it
   shows the last prompt sent, the chips switch between agents, **+** adds another one
   (as tabs by default, or side by side), and the prompt box below sends to the first
   agent. A session that exits offers **Restart**, **Resume** and a switch to another
   agent; one that has exited starts afresh the next time the tab is shown. The processes
   survive closing the workspace, and the agent last used comes back after the app
   restarts. A Markdown path the agent prints opens in the viewer when it lies inside the
   project. The tab stays mounted behind the other two, so switching tabs keeps the
   scrollback and scroll position. The tab flags _!_ while an agent waits for an answer. **Runs** lists the one-shot runs as they finish,
   each revision or merge saying which proposals it came from. Click a ready candidate in a
   finished run to review that proposal; **View output** opens its log. Running, failed and
   already-decided candidates still open their output.
   Runs that wait for a decision also appear as a strip over the agent, so nothing sits
   unnoticed behind another tab. **Review** (one candidate) or **Compare** (several), or the
   _n to review_ button in the header, opens the compare view over the whole window: the original
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
6. **History** is `git log` for the document with the `Parallel-*` trailers parsed:
   what changed, which agent, which instruction, which base. Show the diff or render the
   older version. Revert any entry.
7. **Annotations.** The same composer offers **Note** and **Ask** beside **Edit with agent**. A note
   attaches to the passage as a symbol in its margin; hover it, tab to it, or click it to
   pin it open, and the bubble opens over the document. A question is a bubble an agent
   answers into, running read-only in the checkout; question and answer stay visible
   together. **Ask follow-up** under an answer continues the conversation with the agent
   that answered: the follow-up is a new question on the same passage, and the agent is
   handed the earlier exchange along with it. Resolve (`r`) collapses a bubble to one
   line, Delete removes it with an Undo
   in the toolbar, and **Make task** reopens the composer on the passage with the bubble's
   text (and answer) as the instruction; the bubble then collapses as `task`.

8. **Edit a block.** Hover a block and click its pencil, or click the block and choose
   **Edit block** in the toolbar. Edit its
   Markdown or HTML source, then **Save block** to update the document directly. Surrounding
   content and line endings are preserved. If the file changed meanwhile, saving refuses
   to overwrite it and keeps your text available to copy. Edits made this way, or in an
   outside editor, show as an _uncommitted edits_ chip in the header; click it to discard
   them and return to the committed version. Next to the editor button, a folder button
   opens the project in the file manager.

### How it works

- **Editing happens in the block editor, your editor, or the interactive session.** The app
  watches the open file and re-renders; an external change drops any active selection. The Agent
  tab is a task's AI terminal and prompt box (`TaskAITerminal`, `PromptInput`) over a hidden
  task per project, id `doc-agent-<project>`, kept out of the task order so it is neither
  listed nor persisted; its first agent's pty carries the same id, so reopening the workspace
  re-attaches, and the agent it ran is remembered on the project. Each time the tab is
  shown, the agents are re-armed to attach (a restart clears that for its one spawn) and
  one that exited is reset, since the terminal spawns it afresh. Removing the project
  kills the sessions. A scoped instruction, _your words, then Document, Scope and the
  passage verbatim_, goes to the selected agent as a prompt: typed straight in when the agent looks
  idle (quiet output, no open question, and for Claude no hook turn in flight), else
  queued as the task's initial prompt, which the prompt box sends once the agent is
  ready; a second instruction is refused while one waits. Because the agent edits the
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
  app adds moves the page's own elements. A **Page** toggle
  shows the sandboxed iframe render for pages that lean on scripts or external
  stylesheets, which the inline view does not follow.
- **It lives in two folders.** `electron/documents/` holds the runs, agents, prompts,
  annotations, setup, IPC shapes and the registrar for every channel it owns;
  `src/documents/` holds the UI with its store, types and markdown helpers. The seams are
  `registerDocumentHandlers(win)` and `stopAllDocumentWork()` in main,
  `<DocumentWorkspaceOverlay />` in `App.tsx`, and the sidebar's project row and `+` menu.
  The one runtime module the renderer imports across the process boundary is
  `electron/documents/shared.ts`.

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
