# Reasoning graph

The reasoning graph is the agent's working graph for a task: the goals, questions,
hypotheses, options, evidence and decisions behind a piece of work, published as it
happens. You can edit it too, and your edits are protected from being overwritten.

It shares its model, renderer and editing with the [mind map](mind-map.md); read that
page for the parts common to both canvases. The differences are:

|                | Mind map                       | Reasoning graph                                 |
| -------------- | ------------------------------ | ----------------------------------------------- |
| Authored by    | You, optionally with the agent | The agent, optionally edited by you             |
| Node kinds     | Optional and decorative        | Semantic, with statuses, confidence and sources |
| Lifecycle      | One map per task               | Runs, with a live status line and archiving     |
| Stored in      | App state (`state.json`)       | A JSONL feed in the task checkout               |
| Needs an agent | No                             | Yes                                             |

## Use

Open **Canvas → + → Reasoning**, or just ask the agent in chat — a request such as
_"please create a reasoning graph for this bug"_ makes the agent open the view and
publish into it.

An empty reasoning tab shows the setup form instead of a graph: pick a workflow
(Investigation, Architecture, Research, or Explanation, each with a one-line summary),
optionally tick **Restart … first for a clean context**, and click **Start live map**.
The app sends the workflow instructions to the task's main agent. If it is busy, has
unsent terminal input, or is still starting after a restart, the request queues until
it is ready; **Cancel** removes it. Ticking **Restart the agent first** asks for
confirmation before the conversation is lost. Questions about a node and **Send manual
changes to agent** queue the same way: the status line reads **1 request queued until
the agent is ready** with its own **Cancel**, and the graph stays usable meanwhile.
Only one request waits at a time. An agent exit drops a queued request with a notice;
a workflow change from another pane cancels only a queued activation and leaves a live
connection alone. The form also reminds you that a chat request works just as well.

Once a report exists the form disappears and a status line takes over. While live it
shows the agent, revision, and latest caption; after ten quiet minutes it shows the
idle time instead. After an agent restart it reads **not live** and offers **Resume
live map**, which continues the existing run. **Waiting for the agent's first update…**
notes that this usually takes under a minute, and an append that stays incomplete for
ten seconds is flagged so a stopped agent is not mistaken for a slow one. **New map…**
brings the setup form back over the current graph: starting from it asks the agent for
a fresh run at sequence 0, which archives the current report beside the feed and starts
an empty graph. Saved edits stay keyed to the archived run. **Cancel** returns to the
current graph unchanged. The status line says **Waiting for first update…** until the
requested report arrives.

A graph the agent opens before it has published anything is shown muted, with the
status pill reading **Building…** while the agent is still working (or **Connecting…**
once it has paused), until its first nodes arrive. A report the agent publishes from
chat makes the panel live with no activation prompt sent; the status line reads
**Live · agent · Revision N** followed by the latest caption.

## Workflows

Workflows change reporting guidance only; all four share the same graph and feed
format, and switching one does not rewrite existing nodes. They are defined in
`src/investigation/profiles.ts` and travel to the agent through `reasoning_read`.

- **Investigation** — candidate causes, discriminating tests, evidence, and a conclusion.
- **Architecture** — design options compared against explicit criteria, ending in a decision.
- **Research** — a research question, hypotheses, experiments, and sourced results.
- **Explanation** — how something works today: parts, boundaries, flows, and past decisions.

Explanation is the one to reach for when you want the existing system described rather
than a cause investigated: it asks for plain notes with file paths as sources instead
of chains of evidence nodes.

## Editing

Select a reasoning node with one click; double-click or F2 renames it on the canvas.
Enter adds a child question, or saves the current title while editing. Tab saves and
adds a child question. Arrows navigate spatially. New nodes start plain; pick another
type afterwards from **Node type** in the menu. A selected card shows two quick
buttons: **+** adds a child node and **⋯** opens the same menu as right-click. There,
**Edit details** opens descriptions, evidence, and explicit conflict resolution, while
**Ask about this node…** opens only a question composer (the node's title and notes are
included; **Back to details** returns). Inline renames preserve description drafts,
unsent questions, and agent metadata. Conflicting agent titles block automatic saving;
Details lets you compare versions. Reasoning drafts retain their existing per-run
persistence. Right-click a node for editing and **Delete node**. Del or Backspace
deletes the focused branch, except the root; text inputs retain their normal key
behavior. Undo/redo affects your edits, additions, and deletions, leaving the agent
report intact. Deleted report branches stay hidden even when the agent adds descendants.

Once you have saved edits, added notes, or deleted branches, the panel offers **Send
manual changes to agent**. It sends the agent a summary of those changes with the run
and revision, asks it to adopt what is right in its next update and say what it
disagrees with, and points it at `reasoning_read` for the full view. Unsent drafts are
not included. A busy agent queues the request; once sent, the button stays hidden until
you change the graph again.

## Agent access

`reasoning_read` returns the single current `graph` (the report with saved user edits
applied, plus the protected `userEdited` fields and `userDeleted` IDs), `runId`,
`revision`, `workflow`, the reporting guidance of every workflow, and a `warning` when
the feed is stuck. Unsent drafts and questions are excluded.

`reasoning_update` takes the same atomic operations as `mindmap_update` (`insert`,
`update`, `move`, `remove`, relation and explanation operations) with `runId` and
`expectedRevision` from the last read, a brief `caption`, and optional `activeId`.
Existing IDs, kinds, and parents stay stable; omitted fields remain unchanged. A stale
revision or run rejects the whole batch; the agent reads again. User-edited fields and
deletions are protected unless an operation sets `overrideUser`. For an empty graph, or
on an explicit request to start over, the update also supplies `newRunId`: the old file
is archived beside the feed and the graph starts fresh. When the existing report is
stuck (a truncated or malformed line) the error message says to start over the same way.
The reasoning tab opens when a run starts and stays closed for later updates after you
close it; `canvas_open` with `view: "reasoning"` reopens it without changing content.

Node kinds are `goal`, `question`, `hypothesis`, `option`, `experiment`, `observation`,
`decision`, and `work`; evidence uses `observation`, not `evidence`. Relations need a
kind of `supports`, `challenges` or `fits` plus a rationale field.

## Storage

Reports live in a validated JSONL feed in the task checkout at
`.parallel-code/reasoning/<taskId>/<agentId>.jsonl`, one per task and agent, so two
tasks sharing a checkout or two agents in one task never collide. Each line is an
accepted transaction carrying `runId`, `expectedRevision`, `sequence`, `actor` (`user`
or `agent`), the operations, and an optional caption and `activeId`; snapshots are
replayed from them. The app validates
and appends; agents use the MCP tools instead of writing files. Saved user edits and
deletions remain separate and survive new reports. Existing JSONL histories still load.

Because the feed is a file in the checkout, deleting a task removes it with the
worktree. When a task shares a checkout (direct mode or an external worktree), closing
the task removes only its own report directory. A task keeps only the reasoning
workspace of its current run; starting a new run drops older drafts.

## Export

**Export** offers an HTML page, a Markdown outline, a Mermaid diagram, or the JSON
document, downloaded as a file. The HTML page is self-contained and offline, carrying
the current canvas with the app theme resolved plus the complete graph data; the
drawing is the focused branch, so the data exported with it is too. The formats and the
page builder are shared with the mind map in `src/graph/graphExport.ts`; only the
title, the `Revision N · caption · time` subtitle and the embedded format name are
reasoning-specific (`src/investigation/export.ts`).

## Development

Run Vite with the existing Electron config and open `/investigation.html?view=reasoning`
for the editable reasoning fixture. The original investigation demo remains at
`/investigation.html`.
