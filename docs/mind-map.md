# Mind-map foundation

A free-form map of ideas you own, one per task, usable with no agent connected. The
task's other canvas, the agent-authored [reasoning graph](reasoning-graph.md), shares
this model, renderer and editing; that page covers what is specific to it.

Based on `task/lets-try-this-8d94c5` at `bc9df7e` (the source worktree was clean).
The source snapshot was imported into this checkout without merging branches.

## Use

Open **Canvas → + → Mind map**. No agent connection is needed. Focus mode gives
a graph tab about two thirds of the task beside the conversation; drag the divider
to change the share, which is remembered separately from the tiling width.

- Double-click a topic or press F2 to edit its title. Typing on a selected topic
  starts a replacement title (plus, minus, and equals zoom instead). Clicking
  elsewhere saves; Escape cancels.
- Right-click a topic (or press Shift+F10 / Menu) for every action: rename, notes,
  node type, add child/sibling, move up/down, nest, move one level up,
  expand/collapse, ask the agent, reference in chat, release to agent, and branch
  deletion. Every topic action lives there; the toolbar carries only map-wide ones.
  Reasoning nodes offer their own editing actions through the same menu. Text inputs
  keep their native context menu.
- The toolbar holds **Idea** and **Sibling**, icon buttons for undo and redo, and
  **Export** on the right, which opens the four formats. **Release all** appears
  while you hold ideas the agent may not change, and **Send changes** while there are
  edits the agent has not heard about (disabled while the agent is busy). Both hide in
  a pane too narrow for them and return when it widens, as the reasoning toolbar's
  optional controls do. Escape or an outside click closes the export menu.
- Enter creates a sibling of the focused topic (a child of the central topic); Tab
  creates a child; Shift+Tab moves the topic one level up; Alt+Shift+↑/↓ reorders it
  among its siblings. While editing, Enter saves the title and returns focus to the
  topic; Tab saves and creates a child. **Sibling** is disabled on the central topic.
- Arrow keys focus nearby visible nodes in the requested screen direction.
  Use the branch's +/− button to expand or collapse it; collapsing a branch that
  holds the selection selects the branch itself. Escape focuses the toolbar.
- Delete or Backspace removes the focused topic; a branch with children asks for
  confirmation first. Undo restores it and hands the agent back any authority it
  had over the restored ideas.
- **Notes** opens supporting text for the selected idea. Notes save on change/blur
  (and when the editor closes); nodes with non-empty notes show a note icon. In
  narrow panes the notes stack below the graph. Incoming agent edits preserve
  unfinished notes; conflicting saves retain your draft. Copy it and press Escape
  in the notes field to adopt the latest version.
- Ideas you edited or created show a faint lock; its tooltip lists the protected
  fields. **Release to agent** lets the agent change them again. **Settings →
  Show ownership badges on canvases** hides the locks and the release actions.
- Selecting an idea keeps it, its parent, its children and its cross-linked ideas at
  full strength and fades the rest; hovering an idea moves the highlight to it after a
  short pause. Faded ideas stay clickable, and the reasoning graph behaves the same way.
  Click the canvas background to clear the selection and bring the whole map back to full
  strength; an unfinished title is saved first, as it is when you click another idea.
  With nothing selected, **Idea** adds to the central topic.
- Agent additions get a short highlight; additions inside a collapsed branch show
  an "N new" badge beside its + button until you expand it. Cross-links are drawn
  faintly and light up for the hovered idea; while an idea is selected only its own
  cross-links are shown.
- Undo/redo covers committed edits, additions, removals, moves, and releases (50
  steps per mounted editor). Collapsed branches stay collapsed; only the restored
  idea's ancestors expand. Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, and Ctrl+Y work outside text
  fields, where native text undo remains available.
- Ordinary scrolling pans; Ctrl/Meta+wheel or pinch zooms. Fit map shows the whole
  visible tree. New ideas only move the camera when outside its usable viewport.
  Horizontal maps start with the central topic at the left edge.

One map is saved per task in app state, including collapsed tasks. Closing the
canvas does not delete the map. Camera, collapsed branches, selection, unfinished
inline titles, and undo history are session state rather than persisted document data.

## Extension boundary

`electron/shared/mindmap.ts` (re-exported by `src/graph/model.ts`) defines stable node IDs, ordered parent relationships,
optional cross-links, and a versioned document. Plain nodes require only a title
and detail, with no investigation type or status. Restore validation rejects
cycles, missing references, duplicate IDs, and invalid bounds before rendering.

`applyMapOperations` applies immutable, atomic insert/update/move/remove batches.
It accepts an expected revision for callers that edit a previously read document.
Moving a branch preserves its descendant IDs and cross-links; removal also removes
incident links. Failed transactions leave the original untouched. The editor
clears undo history on externally supplied revisions and protects an inline title
from conflicting updates.

`GraphCanvas` (`src/graph/`) owns the existing Solid/SVG renderer, D3 tree layout, camera, and
animations. Appearance and activity are optional inputs. The investigation
renderer is now a thin adapter supplying its node shapes, assessments, confidence,
and active-work emphasis. Both views share tree navigation helpers and the inline title controller in
`src/graph/inlineEditing.tsx`. The controller handles input focus, typing,
IME composition, cancellation, and Enter/Tab creation; document adapters own
validation, persistence, and undo. Investigation
collapse retains its previous layout spacing; plain-map collapse compacts the tree.

The reasoning feed, editing overlays, contextual questions, and workflow profiles
remain available in **Canvas → + → Reasoning**. Its semantic records extend the
base node/link interfaces, and its editing, runs, storage and agent tools are
documented in [the reasoning graph page](reasoning-graph.md).

## Tasks from either canvas

Right-click a node in a mind map or reasoning graph and choose **Create task from
branch…**. The normal New Task form opens with an editable assignment containing
the saved branch and ancestor notes. Choose the agent and isolation settings before
creating it. The project stays the same, and the base branch defaults to the source
task's branch. The assignment is a snapshot; later canvas edits do not change an
agent's instructions. **Link existing task** connects another task in the same project.

Linked nodes show a live task badge. Click it, or choose **Open linked task**, to
open the task and use its normal agent and review controls. Idle, review, and ready
to merge are distinct states; the badge does not change a reasoning node's assessment.
Links survive app restarts and are scoped to the reasoning run. Closed tasks retain
a disabled badge; **Unlink task** removes the reference. Unlinking or deleting a node
does not stop or close its task. Tree relationships do not schedule work or establish
execution dependencies.

## Agent access

Both graph views offer a **Vertical / Horizontal** layout switch beside the zoom
controls; maps start horizontal, growing left to right. Branch controls sit in their own hit-test layer with space between rows
and columns. Graphs start at **70%** zoom, or **100%** in focus mode. Layout direction
is session state, not an agent edit to the document.

Use **Reference in chat** in a node's context menu to append its stable ID, title,
saved notes, and revision to your prompt draft. Reasoning references also identify
the run. Existing draft text is preserved; nothing is sent automatically. The
prompt box is shown and focused.

Both canvases also offer **Send branch to agent** in the context menu:
**Explain this branch**, **Expand with ideas**, **Investigate this branch**, and
**Challenge this node**. Each prepares an editable request in the normal chat
composer; review it and send when ready. Existing draft text is preserved. The context includes the selected
topic, its ancestors, saved descendant notes (including collapsed nodes), and
relevant links. Reasoning uses your saved view, including added notes and excluding
deleted branches; unsent drafts are not included.

Large branches include a preview of up to 32 nodes with up to 800 characters of
notes each. The request directs agents to read the complete current map through
MCP before answering or editing. Agents without canvas tools can discuss the
provided context and suggest additions in chat. Explaining a branch does not
request map changes; expansion and investigation request focused additions.
Challenging a node asks for evidence on both sides of its assumption, with each
finding attached under that node (in reasoning graphs as observations linked by
`supports` or `challenges` relations).

Normal mind maps also support optional node types through **right-click → Node type**:
Plain (default), Goal, Question, Hypothesis, Option, Experiment, Evidence, Decision,
and Work item. Typed nodes share reasoning's visual styles without statuses or
workflow behavior. Type changes support undo/redo, and new children always start
Plain. Existing maps keep their original appearance.
Hover over **Node type** to open its flyout beside the main menu; it flips left
near the window edge. Right/Left arrows enter and leave the flyout with a keyboard.

Agents can suggest or assign a type through `mindmap_update`: include `kind` on an
inserted node or in an update's `changes`. Use `idea` to return to Plain,
`observation` for Evidence, or `work` for Work item. Other type IDs match their
lowercase labels. Omit `kind` on inserts to leave nodes plain; omitting it from an
update preserves the existing type.

The existing **parallel-code** MCP server exposes **mindmap_read** and
**mindmap_update** for normal maps, plus **reasoning_read** and **reasoning_update**
for reasoning reports. Both use the same task-scoped connection. A third tool,
**canvas_open** with `view: "mindmap" | "reasoning"`, opens or focuses that canvas
tab without changing content, so a chat request such as _"please create a
reasoning graph for this bug"_ or _"show me the mind map"_ works without the
**Start live map** button: the agent opens the view and publishes through the
update tools. The first report of a run and the first map publication open their
tab on their own; later updates leave a tab the user closed alone, which is what
`canvas_open` is for. A graph the agent opens before it has published anything is
shown muted, with the status pill reading **Building…** while the agent is still
working (or **Connecting…** once it has paused), until its first nodes arrive.

The MCP server also sends short instructions on connect that tell the agent the
words _mind map_, _reasoning graph_, and _live map_ refer to these canvases rather
than to files, and which tool serves each, so a plain chat request lands on the
canvas. A report the agent publishes from chat makes the panel live with no
activation prompt sent; the status line reads **Live · agent · Revision N** followed
by the latest caption. When you mention a mind map, reasoning graph, or live map in
a chat prompt, the app appends a short reminder of the canvas tools once per agent
session; prompts the app sends on your behalf never carry it.

New task sessions using the built-in Claude Code, Codex, or Copilot commands receive
the canvas tools automatically. Restart agents that were already running before
this update; existing processes cannot acquire new launch arguments. Coordinators
and their sub-tasks receive the same tools through their existing MCP configuration.
Shells and other/custom CLI commands are not configured automatically.
Explicit MCP launch configuration is also left alone. If the optional canvas
transport or configuration fails, the normal agent still starts with its original
arguments. Live-map activation is disabled with an explanation when the running
session has no configured canvas tools. Canvas configuration never writes global
agent settings or project `.mcp.json` files, and merely making tools available sends
no prompts.

Both canvases mark ideas you edited or created with a faint lock; hovering lists
the protected fields, and **Release to agent** (per idea or for the whole map) lets
the agent change them again. Undoing a removal restores the agent's authority
over the restored ideas. **Settings → Show ownership badges on canvases** turns the
badges and release actions off. Both canvases also export through **Export**, in the
same four formats: a self-contained HTML page carrying the current canvas, a Markdown
outline, a Mermaid diagram, or the JSON document, downloaded as a file.

Try asking the task agent:

> Use mindmap_read and mindmap_update to map this project's UI, state, and backend
> responsibilities. Keep the overview concise and add relevant files as notes.

The agent reads its task's map and revision, then submits a batch such as:

```json
{
  "expectedRevision": 0,
  "operations": [
    {
      "type": "update",
      "id": "<root ID from mindmap_read>",
      "changes": { "title": "Project overview" }
    },
    {
      "type": "insert",
      "node": {
        "id": "ui",
        "parent": "<root ID from mindmap_read>",
        "title": "UI",
        "detail": "Views and canvas"
      }
    }
  ]
}
```

The first successful publication opens the map tab. Later updates preserve the
active tab when the map tab is already present. Both reads and writes use the
renderer’s current task document, including manual edits, even with the canvas
hidden. Data uses normal app-state persistence, not an agent-written JSON file.
A stale revision rejects the entire batch; the agent must read again and reconsider
its changes. There is no automatic merge or retry of stale edits. Inline text
conflicts retain the user's draft, and external revisions clear the editor's
local undo history rather than letting it undo over agent changes.

Transport: agent → MCP stdio → authenticated app HTTP endpoint → Electron IPC →
task canvas store. Credentials restrict ordinary agents to their own task's canvases;
coordinators and sub-tasks reuse existing ownership checks. Canvas credentials
cannot access terminals or task lifecycle tools. Task IDs are bound by the server
session, not supplied as tool arguments. Docker configurations use files inside
the task mount; host configurations use private temporary files. Codex reads the
token from that file (`--token-file`) instead of receiving it on its command line.
The file is deleted when the agent exits or the app quits. Credentials expire
with the transport/session and are not stored in app state. Malformed requests
receive 400, oversized bodies 413, stale revisions or runs 409, and more than four
concurrent requests per agent 429.

To test the reverse direction, rename a node on the canvas and ask the agent to
read the map again. To test concurrency, submit a write using the old revision:
it must fail without changing the map.

Current bounds are 200 nodes, 200 characters per title, and 8000 per note. Cross-links
are represented and rendered, but editing cross-links, free positioning, dragging,
file import/export, and converting between plain maps and reasoning reports are
not implemented.

Ending phone access while an agent still uses the canvas tools keeps the transport
on the local loopback address instead of stopping it, so the shared URL stops
working but the agent keeps its tools.

## Development

Run Vite with the existing Electron config and open
`/investigation.html?view=mindmap` for an isolated, in-memory editor. The original
investigation demo remains at `/investigation.html`.

The larger change comprises the requested source-worktree import, extraction of
the shared renderer/styles, and the new editor, model, persistence, and host tests.
It adds no dependencies beyond those already in the source worktree.

## Module layout

`src/graph/` holds what both canvases share: the `GraphCanvas` renderer, the model,
layout, inline editing, undo history, context menu, ownership, agent actions and the
export formats. `src/mindmap/` holds only what is specific to the mind map
(`MindMapEditor` and its actions and styles), and `src/investigation/` only what is
specific to the reasoning graph.
