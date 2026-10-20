# Plan: optional full-screen reasoning graph

**Status: historical — superseded by focus mode; see `docs/investigation-spike.md` and `docs/mind-map.md`.**

This plan described the host-only increment landed on 2026-09-13. The full-window **Expand** / **Back to side panel** view and `src/components/TaskReasoningView.tsx` it specifies were removed when focus mode replaced the expanded view (commit c6a96139): the graph lives in the canvas side panel, and focus mode gives it about two thirds of the task beside the conversation. The **Connect agent** action referred to in earlier revisions was later replaced by the setup form (**Start live map**, **Resume live map**, **New map…**) documented in `docs/mind-map.md`. Everything below is kept unchanged as history and does not describe the current UI.

## Outcome and scope

Offer **Reasoning** in the existing canvas side panel’s **+** menu. Its **Expand** action opens the optional full-window reasoning view for the current task. It fills the application content area, with the reasoning graph on the left and the existing agent conversation on the right. A resizable divider separates them. A visible Back to side panel action restores the normal task layout. This is an application view, not an operating-system fullscreen transition.

```text
┌──────────────────────────────────────────────────────────────┐
│ ← Back to side panel       Task title · Reasoning                   │
├──────────────────────────────────────┬───────────────────────┤
│ Follow · Fit · Find current           │ Existing agent        │
│                                      │ conversation          │
│       REASONING GRAPH                 ↔                       │
│                                      │                       │
│  Hover: short preview                │                       │
│  Select: details within this pane     │ Existing prompt input │
└──────────────────────────────────────┴───────────────────────┘
```

Start with approximately two-thirds graph and one-third conversation. Reuse the existing resize component, with separate size preferences from the normal task layout. Preserve the compact goal, distinct node types, grey completed/rejected items, pulsating current card, progressive arrivals, hover previews, click-open details, and pan/zoom controls.

The increment delivers the full-window host and reusable graph presentation component. **There is no live task graph source yet:** ordinary tasks show an empty state; an explicitly enabled development example demonstrates a populated graph inside the real task layout. The persistent label “Example graph · unrelated to this task” distinguishes it from the task's actual work. Example controls stay outside the normal graph toolbar and are unavailable in production.

Agent chat means the existing `TaskAITerminal` and `PromptInput`. Preserve the existing agent tabs/splits and prompt destination. Currently the prompt targets `firstAgentId()`, which can differ from the selected terminal tab; entering this view must not silently change that routing. A new chat renderer, session, or selected-tab routing behavior is outside this increment.

Live graph production, graph editing, graph-content persistence, file feeds, MCP changes, graph-to-agent contextual prompts, additional views, timeline UI, multi-agent graph coordination, and package extraction are deferred. The existing canvas hosts a path-free Reasoning tab alongside Markdown documents; the graph instance is shared with the full-window view.

## Architecture grounded in the current app

- `src/components/TaskPanel.tsx` creates `aiTerminalEl` and `promptInputEl` once and reuses them across layouts. Retain their Solid owner and component identity.
- `src/components/TilingLayout.tsx` clips individual task tiles; `src/App.tsx` owns the surrounding workspace and sidebar. A layout confined to a task tile cannot fulfill the full-window requirement.
- `CanvasTabStrip.tsx` supplies the Reasoning entry in the + menu; `TaskCanvasPanel.tsx` supplies Expand. `ResizablePanel.tsx` supplies the split and size behavior.
- `src/store/focus.ts` routes navigation to normal task panels, and `TaskPanel` reacts to those focus changes. Reasoning mode needs an explicit focus scope so shortcuts cannot target hidden task content.
- `src/investigation/InvestigationGraph.tsx`, `layout.ts`, and `presentation.ts` supply the existing Solid/SVG/D3 renderer. Reuse them rather than copying or replacing them.
- `InvestigationInspector.tsx` contains reusable note detail content, but also requires demo history/scrubbing and includes fixture-specific messages. Separate those concerns for embedding.
- `InvestigationView.tsx` owns standalone demo timers, replay, and global theme changes. Do not mount that controller inside the application.

Use an app-level mount target outside the clipped task tiles for the full-window shell, preserving the task-owned reactive scope through a portal. Retain the obscured workspace DOM but make it inert to keyboard and pointer interaction, excluding the reasoning mount and existing dialog portals. Keep the shell beneath existing modal/dialog layers; an open modal retains its normal focus priority and dismissal behavior.

Use one explicit host choice for the terminal and prompt: normal layout or reasoning layout. Normal-layout effects must not reclaim their DOM while reasoning mode owns it. After either transfer, invoke the existing terminal resize/fit path once dimensions are valid. Do not mount a second terminal or composer as a shortcut.

Canvas tab types and persistence include a singleton Reasoning tab. The document workspace’s Agent/Runs/Files rail is unchanged.

## Graph component contract

Create `src/investigation/ReasoningGraph.tsx`. Its inputs are:

- A task-scoped graph key that changes when the task or graph run changes.
- An optional trusted internal `Snapshot`, using the existing record vocabulary and revision sequence.
- Visibility, including whether its task and full-window presentation are active.

The task host supplies these inputs. The component owns selection, collapsed branches, follow/hold mode, the held displayed snapshot, and detail visibility. The existing renderer remains the sole camera owner. Coordinates and other presentation preferences stay outside semantic records. Reuse the renderer instance while the same task/graph is retained; pass visibility through explicitly.

A newer revision under the same key updates the latest input. Re-delivery of the same revision is harmless. The host supplies monotonically increasing revisions; a reset uses a new graph key. A key change clears old presentation state, even while hidden. A missing snapshot displays “No reasoning graph available for this task” rather than another task's records. External-input validation and accepted event history belong to a later data adapter, not this component.

Because the input contains snapshots rather than a complete event stream, show **“Newer update available”** when the display is held. Do not infer an event count or fabricate intermediate revisions. “Return to current” explicitly resumes following.

Visibility rules:

| State when hidden      | Behavior on return                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Following              | Show only the latest snapshot immediately, without catch-up animation.                                                    |
| Held                   | Preserve the displayed snapshot, selection, collapsed branches, and camera; indicate newer input until Return to current. |
| Task/graph key changed | Reset presentation state and show the new graph or its empty state.                                                       |

Hidden views run no pulses, camera travel, or position animations. Initialize the camera only when dimensions are nonzero. Closing the reasoning presentation retains its graph state for the mounted task session; closing the task disposes frames, observers, and gesture listeners. Do not persist the open full-window mode across restarts.

## Implementation slices

### 1. Prove the full-window host and session preservation

Add the side-panel Reasoning tab and its Expand action, plus `src/components/TaskReasoningView.tsx`. Establish the app-level mount target, full-window header, Back action, horizontal splitter, and graph placeholder. Transfer the existing terminal and prompt using the explicit host choice above. Restrict focus navigation to the visible graph placeholder, agent panes, and composer while the presentation is open; retain task-switch shortcuts.

This is the first slice because transferring the existing conversation without breaking its lifecycle is the main integration risk. Start with the graph empty state, before coupling this work to graph interactions.

Likely files: `App.tsx`, `TaskPanel.tsx`, `TaskCanvasPanel.tsx`, `CanvasTabStrip.tsx`, new `TaskReasoningView.tsx`, and `src/store/focus.ts`; add scoped host styles where existing conventions require them. The broader integration surface is justified by full-window hosting and hidden-panel focus safety.

Acceptance and verification:

- Enter from both tiled and focused layouts with the sidebar visible. The view covers the application workspace, remains below dialogs, and restores the previous layout on Back.
- Terminal/composer DOM identity, scrollback, selected tab/splits, prompt draft, and unsaved Markdown edits survive entry/exit. Verify no extra PTY, session, or input subscription.
- With two agents and the non-first terminal selected, entry/exit preserves the actual existing prompt destination. Normal split thresholds or canvas visibility changes cannot move conversation elements back into hidden containers.

### 2. Embed the graph presentation component

Compose `ReasoningGraph` from the existing renderer and note details, then replace the placeholder. Keep compact follow/hold, Fit, Find current, and zoom controls. Bound hover previews and the detail drawer to the left pane. Adapt the inspector so history, scrub callbacks, and example disclosure are optional; use neutral missing-record wording. The standalone demo retains its replay capabilities.

Inherit app theme and fonts. Preserve reduced motion. Implement the input and visibility rules above. Add an explicit development-only example switch in the real task host using the existing fixture, with its own advance control and persistent disclosure. The right pane remains the real task conversation; the example is not linked to that agent.

Likely files: new `ReasoningGraph.tsx`, existing `InvestigationGraph.tsx`, `InvestigationInspector.tsx`, graph CSS, and the task host's narrow example adapter. Avoid renaming the investigation module or duplicating its renderer.

Acceptance and verification:

- Production tasks without graph data show the empty state. The development example runs inside the full-window task layout and is clearly marked as unrelated to the task.
- Component tests cover newer/duplicate revisions, identity changes, missing snapshots/selected records, and both hidden-return paths. Graph interactions send no IPC or agent commands.
- Current-node pulse, arrival animation, hover, selection, and collapse work in the left pane; reduced motion disables travel/pulsing and no graph detail covers the conversation.

Checkpoint after slices 1–2: demonstrate the real task session alongside the labeled example, including return to normal task view. Do not expand into live graph transport.

### 3. Complete graph navigation and return behavior

Find current expands any collapsed ancestors as a presentation-only change and locates the explicitly declared active node in the displayed snapshot. While held, it does not adopt the latest snapshot; only Return to current does that. When the displayed snapshot has no active node, disable Find current with a clear explanation. Selecting a node holds the graph; closing its details returns focus to that node if visible, otherwise to a graph control.

Back restores the previously focused task control if it still exists, otherwise the task panel. Escape dismisses an inner graph popup/details first. It exits the reasoning presentation only from workspace chrome when no inner handler consumes it. Do not capture Escape intended for the terminal or bypass App's existing modal handling.

Task switching exits reasoning mode instead of showing the old task over the new one. Returning to that task can reopen its retained graph state. Divider resizing and visibility changes update viewport dimensions without automatically fitting or moving a held camera. Suspend background task layout measurements that would overwrite the user's normal layout size preferences.

Likely files: the task host, `TaskPanel.tsx`, graph component/renderer, and focus routing only where needed to complete the first slice's scope.

Acceptance and verification:

- Keyboard navigation reaches only visible controls; graph dismissal, Back, and terminal Escape follow their respective scopes.
- Find current works for a node hidden by collapse, and an idle snapshot never acquires an invented active node.
- Repeated open/close, divider resize, task switch, and task close cycles preserve the correct state and leave no duplicate listeners or hidden animations.

### 4. Verify the complete view in Electron

Exercise the fixture inside the actual task host: hypotheses arrive, an experiment becomes current, evidence changes an assessment, and a rejected branch reopens. Confirm the current card pulses while its text stays stationary. Hold/select a branch, hide the view, advance the fixture, and reopen: the held display remains stable and indicates newer input. Repeat while following and verify immediate display of the latest snapshot.

Check light/dark themes, reduced motion, mouse drag, wheel pan, Ctrl/pinch zoom, keyboard navigation, modal layering, and divider resizing at 1024 and 1440 px window widths. Return to the existing canvas and verify its unsaved document state. Exercise the mini-browser too if present in the integration checkout; it is not implemented in this checkout and is not a dependency of this work.

Use 30/100-record fixtures as stress checks. Fit remains an overview rather than a promise that all labels are readable at once. Verify controls and selected details remain usable when the graph pane is narrowed.

Run existing semantic/layout tests and focused graph/task-layout client tests; add host tests for the lifecycle and focus invariants above. Run `npm run typecheck`, scoped ESLint/Prettier, and `npm run build:frontend`. Record observations and limitations in `docs/investigation-spike.md`. Fixture checks do not establish live agent integration.

## Completion criterion

The current task can enter and leave the full-window reasoning layout while continuing the same agent session without losing task state. The reusable graph component handles a missing snapshot and supplied task-scoped snapshots. A clearly labeled development example demonstrates graph interaction inside that layout; live task graph production remains a later increment.

## Review disposition

Two independent agents reviewed integration/lifecycle and scope/usability. This revision addresses app-level hosting outside clipped tiles, focus routing, exact prompt destination, exclusive DOM ownership, held-versus-following visibility behavior, snapshot identity, inspector demo coupling, collapsed-current navigation, and the missing-data boundary. Neither review required expanding into transport, graph editing, or additional views.
