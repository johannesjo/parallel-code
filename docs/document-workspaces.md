# Document Workspaces

**A project type in Parallel Code for exploring problems in prose**

Status: experimental, behind the _Document workspaces_ switch in Settings → Experimental.
Slices 1 and 2 of the plan below are built; annotations and HTML are not.

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
2. Click **+** next to Projects and choose **Document project**. Pick a Git repository and
   one tracked Markdown file in it.
3. The workspace opens full-window with three tabs: **Document**, **Compare**, **History**.
4. In the document, select text, click a block, or press **§** next to a heading to select
   the section. A composer opens under the selection: type an instruction, pick agents and
   candidate counts, press Enter.
5. Proposals appear in the right-hand rail as they finish. **Review** (one candidate) or
   **Compare** (several) opens the compare view: base on the left, candidates to the right,
   each starting with its rationale. Accept one, or reject all.
6. **History** is `git log` for the document with the `Parallel-*` trailers parsed:
   what changed, which agent, which instruction, which base. Show the diff or render the
   older version. Revert any entry.

### How it works

- **Editing happens in your editor.** The app watches the file and re-renders; an external
  change drops any active selection.
- **Dispatch commits pending edits first** as a plain `Manual edits` commit so every run
  has a real base. Only tracked files count as pending edits: untracked scratch files
  and everything under `.parallel/` stay out of that commit.
- **Headless agents.** Each candidate runs the official CLI in print mode inside its own
  worktree under `.worktrees/parallel-doc/`: `claude -p --output-format stream-json`
  with tools limited to Read/Edit/Write/Glob/Grep, `codex exec --json --sandbox
workspace-write` (the sandbox blocks writes outside the worktree),
  `gemini -p --output-format json --approval-mode auto_edit`. Process exit means the
  proposal is ready. Cancelling kills the CLI's whole process group. OpenCode and Copilot
  expose an unrestricted shell in print mode and are not offered until they can be
  restricted.
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
- **Acceptance is one squashed integration commit** on the checked-out branch, containing
  the document and the run record `.parallel/runs/<id>.json`. A proposal whose base is
  behind HEAD is merged three-way on acceptance and marked stale if it no longer applies.
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
- **Run records are versioned** (`version: 1`) so a format change is a migration.

### Not in this slice

Annotations, HTML documents, partial acceptance, evaluator agents, refinement rounds,
durable anchors across versions, in-app editing. Custom agents, OpenCode and Copilot
cannot be picked. Gemini runs one-shot only.

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

1. Annotations: bubbles on anchors, agent-answered questions, single-keypress dismissal.
2. HTML: static sandboxed preview with DOM-to-source mapping.
3. Durable anchors and selective integration; research projects with sources and roles;
   semantic comparison by claim and decision.

### Kill criteria

Judging candidates takes longer than writing the passage yourself, or you find yourself
accepting the first candidate without reading the rest. Either means the comparison loop
does not hold for prose, and the answer is to stop rather than to add roles, formats, or
evaluator agents.
