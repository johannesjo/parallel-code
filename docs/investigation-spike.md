# Investigation replay spike

Updated 2026-09-13. **Keep Solid + SVG with D3 utilities for the standalone prototype.** G6 has been removed. The standalone rendering/replay checkpoint is preserved on local branch `prototype/reasoning-graph` at `c14b82b`. The task-host integration places the graph in the canvas side panel; focus mode gives it about two thirds of the task beside the conversation, replacing the earlier full-window view. The subsequent live-report integration below connects the task's agent through a validated JSONL file; graph-to-agent contextual questions remain deferred.

## Transcript jumps (2026-09-15)

Second increment from the research doc, for the “what was going on” question. The agent terminal's scrollback-marker API now takes string keys (the retired Steps panel used `step:<index>`), and the reasoning host registers `reasoning:<sequence>` at the terminal's current line for each agent update it observes while the pane is visible and polling. Updates already in the feed when polling starts or resumes are catch-up and are not anchored, mirroring how historical steps are not jumpable; the feed exposes that boundary as `jumpableFrom`. The details card offers **Jump to transcript**, which scrolls the terminal to the last agent update that inserted, changed, moved or linked the note and focuses the terminal; when nothing is anchored it says so. User edits leave no transcript and are never targets.

Limits: a mark is placed when the one-second poll notices the update, so it lands up to a second after the agent's tool output; markers die when scrollback truncates; the development example has no transcript. Verification: unit tests for the update lookup, feed tests for the catch-up boundary across hide/show, host tests for marking and jumping, inspector tests for the button, and all component, document and investigation client suites (452 tests) with `npm run check`. Not verified: native Electron marker placement with a real agent.

## Verification marks (2026-09-15)

First increment from `docs/reasoning-graph-research.md`. The details card now shows hypothesis confidence as the agent's own estimate beside what backs it: counts of `supports` and `challenges` relations on that record and its source count. A confidence with no linked relation is dimmed. Task-relative sources are checked for existence through the existing path-exists IPC when a card opens; a missing file shows a “Missing file” mark next to the location. URLs are not checked, and an unreadable checkout shows nothing rather than a false mark. Line ranges are not checked. The reporting prompt additionally asks the agent, whenever it makes a hypothesis active, to record what would refute it as an experiment or observation linked with a `challenges` relation before marking the hypothesis supported.

Verification: inspector, host and feed tests cover the grounded line, the bare state, missing and unknown checks, URL exclusion, and the prompt wording. `npm run check` passes. Not verified: a real agent following the refuting-check instruction.

## Editable note cards (2026-09-14)

Larger maps stay navigable in two ways. **Focus on this branch** in a note's context menu shows only that branch, with its ancestors as a breadcrumb above the stage; a crumb re-focuses on that ancestor, **Whole map** or Escape on a note returns to everything, and cross-links inside the branch stay visible. Exports made while focused contain the focused branch. The toolbar's **Find notes** box matches titles first and saved text second; picking a result expands collapsed ancestors, leaves a focused branch if the note lies outside it, and selects the note. Neither changes the saved map.

The task reasoning graph shows note details in a panel docked beside the graph. It follows the selection, so clicking another note switches the panel instead of closing it; Escape or the close button closes it, and drafts remain available when the note is reopened. Sources and acceptance criteria are collapsed by default. The standalone replay keeps its own read-only details panel.

This first editing increment supports titles/descriptions, adding connected notes, and up to 50 undo/redo steps during the current graph session. User text overrides, local notes, and unsent questions are persisted with the task, scoped by task/agent/report run; they never rewrite the agent JSONL history. Untouched fields continue to follow agent reports. Colliding text updates show the latest agent version and require an explicit “Keep my changes” action. Saves from a held view apply to the current graph. Undo history itself is not persisted.

“Ask agent” opens a composer in the note card. Sending includes the current note text, reported ancestry/relations and revision, and the user’s question through the existing first-agent prompt route. It preserves the main task composer draft, blocks busy/question-waiting sessions, and retains unsent questions after failures. Sending into a real AI session has not been exercised in verification; host tests cover routing and failure behavior with mocked IPC.

Automatic layout remains in use. Free positioning, changing existing node types/parents, removing notes/connections, editing sources/assessments, and agent execution controls are subsequent increments. The implementation is larger than a visual panel replacement because it also adds the independent edit model, persistence, conflict handling, contextual prompt routing, and regression coverage.

Verification: 194 focused unit tests and 81 client tests pass. Type checking, ESLint, formatting, Knip, dependency checks, and the frontend production build pass (existing chunk-size/plugin-timing warnings remain). Chromium checks exercised editing, conflict acknowledgment, connected-note creation, expanded cards, Escape, and 400 px panes in wide/narrow windows. An incoming report moved the open card by 0 px; light/dark screenshots were inspected and no renderer errors were reported.

## Current renderer decision

The G6 prototype could render the story, but its uniform rectangle presentation and wheel-to-zoom navigation did not satisfy the walkthrough. Those were adapter choices, not evidence that G6 cannot support custom nodes. The focused fallback uses the same fixture, replay state, and inspector: Solid renders HTML note buttons inside SVG, `d3-hierarchy` computes the navigation tree, and `d3-zoom` / `d3-selection` handle camera gestures. The installed D3 modules have ISC licenses. G6 and its 44 exclusive package entries were removed.

The goal is a compact neutral card with a target symbol and a subtle left rule, the question an open underline, hypotheses have a top rule and diamond symbol, evidence uses folded note slips, experiments use capsules, decisions have a diamond marker, and work items use a dashed checklist row. Only the explicit current item receives a filled blue treatment and “Working now” marker. Its ancestry uses a restrained blue connecting line without recoloring every card. Completed and rejected items remain grey; disputed and reopened assessments remain visible. Hover previews and click-open details preserve progressive disclosure.

Ordinary wheel/trackpad scrolling pans; Shift+wheel pans horizontally. Pinch or Ctrl/Meta+wheel zooms around the pointer, with a gentler wheel sensitivity than D3's default. Background drag, arrow keys, zoom buttons, 100%, Fit map, Find current, and Read selected offer explicit navigation. The default is 100% with 12 px note titles; Fit is an overview and can still make labels too small in short windows or large trees. This fallback does not solve the geometry of fitting 100 prose notes on one screen.

Solid keys buttons by record ID, preserving focus through assessment revisions. One replaceable 320 ms animation interpolates node positions and opacity from the current frame; discoveries emerge from their parent. Links use the same positions. No animation queue accumulates behind semantic history. Camera travel is cancellable, and reduced motion bypasses travel. Collapse retains the space occupied by reported descendants. Layout never sees future fixture records or evidence cross-links.

Verification on 2026-09-13: 11 semantic/layout tests and 10 client tests, including the real SVG renderer's discovery interpolation, focus identity, wheel panning, explicit zoom, and reduced-motion cleanup. Type checking, scoped ESLint, and the isolated production build passed. Native Electron mouse input verified hover, click-open details, wheel pan without zoom, gentler Ctrl+wheel zoom (1.00→1.21 for the tested wheel event), drag, and an incoming update while reading H2: selected movement was 0.0 px and S5 remained held with S6 received. A discovery was sampled at opacity 0.50 during its transition. No renderer exceptions were observed. Light and dark screenshots were inspected.

At 30 and 100 rendered records, each ten-update annotation burst reached S18 without backlog. A 0.9-second RAF sample at each size reported p95/max 16.8 ms and zero intervals above 25 ms (56 samples each). These burst samples used reduced motion and light mode; they do not benchmark animated 100-node insertion, input latency, or compositor dropped frames. The existing device details below apply. Human comprehension and engagement remain unmeasured.

The current isolated entry builds to **94.70 kB JS / 32.98 kB gzip**, plus **67.01 kB CSS / 13.07 kB gzip** and fonts, using the same dedicated build method as the earlier **1,440.58 kB / 416.40 kB gzip** G6 entry. This compares complete prototype versions, not library-only sizes or shared-app load time. The normal entry still does not import this prototype.

This is a larger change because it replaces the renderer and tests its navigation and animation boundary. The fixture and replay contract remain shared; there is no second UI runtime, graph editor, or custom layout algorithm. Primary references: [D3 tree layout](https://d3js.org/d3-hierarchy/tree) and [D3 zoom gestures](https://d3js.org/d3-zoom).

## Earlier G6 presentation experiments

The following presentation notes and initial measurements are historical; the current renderer decision above supersedes the G6-specific behavior.

### Top-to-bottom revision

Updated after the first walkthrough: the graph now grows **top to bottom**, with compact cards, 12 px titles, and zoom capped at 1×. S0 shows the goal and reported question; S1–S3 introduce H1, H2, and H3 separately. New records fade in over 300 ms as their checkpoints arrive. The remainder of the original story now occupies S4–S8.

A green WORKING badge/halo identifies the active record in the viewed snapshot, independently of the blue selection border. The Current work strip tracks the latest declared work even while an older snapshot is held, with an explicit historical-view note. Its activity dot respects reduced motion, and the strip says “No active work reported” when there is no declaration.

G6's CompactBox function now lays out **only the reported navigation tree**, anchoring the root. Future records are neither rendered nor used to reserve positions. This intentionally permits existing siblings to make room as branches are discovered; holding the snapshot still prevents incoming updates from moving the reading view. A short entry fade accompanies each discovery. Shared evidence overlays remain outside layout input. The initial rendering/replay checks passed; subsequent visual refinements are described below. The measurements below describe the earlier horizontal version and have **not** been rerun for the new layout.

### Attention refinement

The active record and its ancestry now form a stronger green path; unrelated nodes and edges are dimmed. Completed work and rejected hypotheses use muted grey text and dashed outlines. Selecting a muted item restores its readability while keeping its settled status visible. Reopening a hypothesis removes that settled treatment. Observations remain evidence rather than being classified as completed decisions.

The active card's halo breathes over 1.7 seconds without moving its text. Its animation is cancelled before graph updates and on disposal, and disabled for held/replay views and reduced motion. The canvas background is plain. When no current work is declared, there is no invented active path. Three additional attention tests cover ancestry, settled/reopened transitions, and idle state.

A follow-up motion fix separates held/replay presentation from reduced motion: replay had been setting G6 animation to `false`, making nodes appear instantly. Entry, position, opacity, and branch emphasis now transition over 300 ms; camera focus and Fit also animate. User pan/hold cancels camera travel. A browser frame probe verified intermediate replay opacity and camera positions, and a client regression test covers replay, held branch interaction, and the reduced-motion override.

The development watcher was also narrowed to ignore worktrees **nested under** the current checkout, so it no longer suppresses changes merely because this checkout itself lives inside `.worktrees`. Two watcher checks cover the active checkout and nested worktrees.

### Hierarchy and progressive detail (2026-09-13)

The standalone prototype now includes goal G1 and its acceptance criteria, a question, hypotheses, evidence, experiments, decision D3, and proposed work W8. Decisions can become disputed when their premises change; no worker execution or pause is fabricated. A recorded result is attached to its work item. Navigation follows the branching sketches; the inspector exposes the full goal-to-note trail.

Cards show a type symbol/label and one short title. Goal and question cards are larger (224 × 58 and 208 × 56); branch notes range from 152 × 46 to 164 × 54. Assessment badges appear for consequential disputed/reopened/rejected states. Completed/rejected notes remain grey, and the declared active path retains its green emphasis. Variable card dimensions are included in CompactBox centering.

The inspector starts closed. Hover shows a bounded preview without changing selection or holding playback. Click or the keyboard-accessible **Browse notes → Inspect** opens full detail, acceptance criteria, results, and interpretation links; history is expandable. Closing returns focus to the note selector. Demo settings, the type legend, and diagnostics are collapsed by default. The normal task panel remains unchanged; the unfinished integration exploration was set aside when the scope returned to the prototype.

Verification: 9 semantic tests and 7 client tests; type checking and scoped lint. Native Electron pointer input verified H2 hover without selection/hold, click-open details, and an incoming S6 update while reading S5: selection and inspector were retained, selected-node movement was 0.0 px, and the unseen count became one. These are interaction checks, not a new 30/100-record performance benchmark.

## Task reasoning view integration (2026-09-13)

### Start a live map

An empty reasoning tab (**Canvas → + → Reasoning**) shows a setup form instead of a graph. Pick a workflow (**Investigation**, **Architecture**, **Research**, or **Explanation**, each with a one-line summary), optionally tick **Restart … first for a clean context**, and click **Start live map**. The app sends the workflow instructions to the task's main agent through the existing prompt path. Opening the tab alone sends nothing. If the agent is busy, has unsent terminal input, or is still starting after a restart, the request queues until it is ready and **Cancel** removes it; an agent exit drops a queued request with a notice. The agent must have access to the task's working directory and cooperate with the reporting tools; the app does not extract hypotheses from terminal text or hidden reasoning. Markdown investigation documents do not populate the graph.

Once a report exists the form disappears and a status line shows the agent, revision, and latest caption. After an agent restart it reads **not live** and offers **Resume live map**, which continues the existing run. **New map…** brings the setup form back over the current graph; starting from it asks the agent for a fresh run at sequence 0 and archives the current report beside the feed. The form also reminds you that a chat request works just as well: a graph the agent opens from chat skips the activation prompt, so `reasoning_read` returns the guidance for every workflow and the agent follows the one whose shape matches the question. The complete form, queueing, and status vocabulary are documented in `docs/mind-map.md`.

The workflow chosen in the form shapes the instructions sent. Investigation guides causal testing; Architecture guides options and explicit tradeoffs against criteria; Research guides methods, sources, reproducibility, and measured uncertainty; Explanation guides a descriptive map of existing structure with plain nodes, decisions, and file sources instead of evidence chains. Architecture suitability and scientific uncertainty are not hypothesis confidence.

Architecture adds `option` nodes, usually `proposed` or `rejected`; a separate Decision records the choice and rationale. Any record can include optional `sources` (at most 20): a nonempty `label` plus either an HTTP(S) `url`, or a task-relative `path` with optional positive `line`. For example, `{"label":"Benchmark","path":"results/benchmark.json","line":12}`. The details panel shows each destination; **Open source** opens validated web URLs through IPC, while **Copy location** copies local references without opening files. Existing records and feeds remain valid. Structured quantitative research results remain a later extension.

**Compare options** appears when the displayed report contains Option nodes. It groups alternatives by their shared parent and compares them against ancestor criteria, option criteria, and any additional evaluated criteria. Options may report `evaluations: [{"criterion":"Latency below 100 ms","assessment":"Measured p95 of 82 ms; meets the target."}]` (at most 200, unique nonempty criterion names up to 1000 characters and nonempty assessments up to 2000). The app displays missing assessments as **Not assessed** and assigns no score or winner. Selecting an option opens its details and sources and pauses following; **Follow updates** updates both views. **Show graph** restores the mounted graph and camera. Narrow panels scroll horizontally with the criterion column fixed. Ask in chat to request structured evaluations from an existing session.

Reports live at `.parallel-code/reasoning/<taskId>/<agentId>.jsonl` in the task worktree. Starting a live map prepares the directories and adds a local Git exclude rule. The path isolates agents and tasks even when they share a checkout. Visible graph panes ask the main process once per second whether the file changed, passing the stamp (size, modification time, inode) of the last read; an unchanged feed costs one `stat` and no file read. Edits and agent updates written through this app trigger an immediate re-read, coalesced with any read in flight. Hiding the pane stops polling; reopening reads the latest file. Closing the task cancels pending delivery. Existing files restore the graph after an app restart; a changed task, agent, or reported run resets graph presentation state.

Each newline-terminated JSON object uses the existing update contract:

```json
{"runId":"investigation-1","sequence":0,"caption":"Investigating the reported failure","records":[{"id":"goal","kind":"goal","title":"Fix the reported failure","detail":"Scope and acceptance criteria for this task","status":"unresolved"}]}
{"runId":"investigation-1","sequence":1,"caption":"Checking a possible cause","activeId":"h1","records":[{"id":"h1","parent":"goal","kind":"hypothesis","title":"A retry repeats the write","detail":"Untested; compare request IDs and persisted rows","status":"untested"}]}
```

Hypotheses may report optional `confidence` from 0 to 1, displayed as an agent-reported percentage. Omitted confidence remains unscored; the app does not infer it from status. Cards hide internal IDs, show up to four title lines with measured row spacing, and dim branches outside the active and selected ancestry. The Working now label is green and pulses while the latest report still declares that item active, including during selection or a held view. Idle reports retain a static Worked on last marker. Reduced-motion preferences disable the pulse. Evidence and experiment icons are smaller.

Sequences start at zero and increment by one. Updates replace supplied records in full and retain omitted records; IDs, kinds, and navigation parents stay stable. Optional `relations` connect existing records with `supports`, `challenges`, or `fits` and a rationale. Optional record `criteria` and `result` carry acceptance criteria and outcomes. `activeId` identifies explicitly reported current work; omitting it clears the current-work marker. The workflow instructions list all supported kinds and statuses and asks for meaningful updates plus a final idle update. A fresh run replaces the file with a new `runId` at sequence zero.

Validation rejects unknown types/statuses, duplicate identities, missing references, cycles, multiple roots, changed accepted history, and sequence gaps. Identical repeated updates are harmless. Limits are 1 MB, 1000 lines, 200 records and 200 relations, with bounded text fields. The reader rejects non-regular files and symlinked report paths. Partial final lines wait for completion; malformed appends show an error and keep the valid prefix, including the last previously accepted snapshot. A paused view continues to show its selected revision until **Follow updates**.

Native Electron verification at the time (with the since-replaced **Connect agent** action) used an isolated local reporting process: the activation prompt reached the first of two agent terminals, that process wrote two updates, and the graph populated through the real file/IPC path. Subsequent appends respected hold mode, fullscreen transfers retained the terminal and composer, the draft survived connection, malformed input retained the graph, and the PTY count stayed at four across two tasks. No renderer exceptions occurred. This verifies transport and UI integration; adherence by a real AI model has not been tested, and graphs contain agent-reported claims rather than independently verified findings.

Review follow-up: the activation prompt claims the same manual-input hold as the composer before preparing the feed and refreshes it before delivery, preventing coordinator automation from competing with the prompt. Preparation rejects existing symlinks and nonregular report targets. Matching accepted updates reuse their validated snapshots; file order and content are still checked, and replacement runs receive full validation. In an isolated Node benchmark with a 200-record parent chain and 1000 updates (75,356 bytes), appending the final update after accepting 999 took a median 2.05 ms versus 676.68 ms before the fix (five samples each). This measures parsing of an append, not initial loading or rendering. The independent reviewer rechecked all three fixes with no further actionable findings.

Automated validation after the fixes: 2570 unit tests and 277 client tests passed, including unsafe existing targets, accepted-snapshot reuse, manual-input hold, hidden-feed cleanup, late task responses, and closing during preparation. Type checking, Electron compilation, ESLint, and Prettier passed. The integration had also passed Knip, dependency-cruiser, and the frontend production build, which retains its existing chunk-size warnings.

### Earlier host-only increment

Open the task’s canvas side panel and choose **+ → Reasoning**. There is no dedicated reasoning button in the task header and no separate expanded view: focus mode gives the graph about two thirds of the task beside the conversation. Reasoning tabs are saved with the other canvas tabs.

Before an agent reports, ordinary tasks show “No reasoning graph available for this task”.

Graph panes narrower than 600 px automatically use compact cards and tighter branch spacing. Hypotheses shrink from 196 px to 112 px, allowing three sibling hypotheses to fit within a 400 px pane at 100% zoom. Titles retain 12 px text and wrap to two lines; hover and details expose the full content. Wider panes restore normal card widths without remounting the graph. Resize, camera-follow, and 100-record non-overlap tests cover both layouts; a browser check verified the 400 px presentation.

The reusable component follows the newest supplied task-scoped snapshot by default. The toolbar's follow menu offers **Follow updates** and **Pause updates**; selecting or moving the map pauses following, and later input shows **Paused · new updates** until **Follow updates** resumes. A held view, selection, collapsed branches, and camera survive hiding. A following view skips hidden animation and displays only the latest snapshot on return. Changing the graph key clears prior presentation state. Find current expands collapsed ancestors without adopting a newer held snapshot.

Verification: 41 semantic/layout and focus tests, plus 23 client tests. The client checks cover repeated terminal/composer transfers, unsaved notes and canvas element retention, graph identity and missing input, hidden-return animation, collapsed-current navigation, Escape, and focus restoration. Type checking, scoped ESLint/Prettier, Knip, dependency-cruiser, and the frontend production build pass. The build retains its large-chunk/plugin-timing warnings; the full repository suite was not run.

Native Linux Electron checks used isolated application data and local echo agents, without an AI service. Entry/Back preserved terminal and composer DOM identity and edited drafts in tiled and focused layouts. With two agents per task, the second tab stayed selected and a test prompt still reached only the first agent, matching existing routing; the process count remained four. The labeled example retained its held snapshot, selection, and camera across newer input and reopening. Keyboard navigation stayed in visible panes, terminal Escape did not exit, a Help dialog appeared above the view, and switching tasks closed it. Screenshots were inspected at 1400 × 900 and 1024 × 800 CSS viewport sizes. No renderer exceptions were observed. Native unsaved-file editing and macOS were not exercised; fixture checks do not establish live graph integration.

The layout fix recreates only the lightweight normal-layout containers when returning, letting them reclaim the task-owned content. Keeping those old containers alive left stale insertion references and detached the terminal/composer on Back. Adding the side-panel entry reuses the existing canvas tab menu and persistence instead of adding a separate panel system. The broader diff also included the reusable graph boundary, the full-window portal (since replaced by focus mode), focus routing, and regression coverage required by this integration.

Side-panel follow-up verification: 98 canvas/persistence unit tests and 46 canvas/graph/transfer client tests pass. The native check entered through **+ → Reasoning** and completed three **Expand → Back to side panel** cycles, retaining the same graph/terminal/composer DOM, held details and camera, and edited draft; that expanded view has since been replaced by focus mode. The local echo spawn count remained four, with no renderer exceptions. Type checking, scoped lint/format, dead-code and dependency checks, and the frontend build pass.

## Try it

The standalone replay remains available:

```sh
npm run dev:investigation
```

This starts Vite on port 1422 and a separate Electron window with temporary user data, no preload, and no agent processes. Close the window to stop both processes. The normal application and Markdown canvas are unchanged. For browser inspection, serve the existing Electron Vite configuration on port 1422 and open `/investigation.html`, which loads the development harness at `src/investigation/demo/dev.tsx`.

1. Choose **Story** and **Run demo**, or use **Next demo update** to publish one scripted checkpoint.
2. At S5, select **H3**. Continue the demo input: S6 challenges T4 while the inspector, snapshot, and camera stay held. The unseen badge names the latest change.
3. **Return to live**, select E21 in **Browse notes**, and inspect its three interpretations. Its observation identity remains the same when support for H2 becomes merely “fits”.
4. Select H2, collapse/reopen its branch, and scrub to S4. Select E22 at S6 or later, then scrub before its creation: selection remains identifiable and the inspector says it did not exist yet.
5. At S8, try **Burst of 10**, then **Replay**. All ten synthetic annotation revisions remain in the timeline; visual transitions use the latest accepted state.
6. Repeat with **30 records** and **100 records**. These counts apply at S8, before collapse; extra records are explicitly synthetic load samples. **Fit map** provides an overview; **Read selected** centers a record at a 12 CSS pixel label size.

Demo input controls simulate incoming checkpoints. Hold, selection, replay, and scrubbing only change presentation. No control sends an agent command. Active-work markers appear only for an explicit fixture declaration. Replay and held branch expansion retain transitions; only the reduced-motion setting disables graph animations. Historical nodes pulse only while the latest report still declares that same node active.

## Implementation boundary

- `src/investigation/state.ts`: immutable snapshots, ordered atomic fixture updates, identity/reference checks, idempotent duplicate delivery, and collapsed navigation projection. This typed internal contract **does not validate external JSON**; it must not be used directly on an untrusted feed.
- `fixture.ts`: the nine semantic S0–S8 updates, plus optional load samples. All observations are illustrative and unverified, not findings about Parallel Code.
- `InvestigationGraph.tsx`: Solid owns the SVG and HTML note buttons; D3 owns camera gestures. Evidence links appear only for selection and never participate in tree layout.
- `layout.ts` computes D3 tree positions for each reported navigation snapshot. One animation frame loop updates displayed positions and opacity; new states replace pending motion. No future records reserve space.
- Animation frames, gesture listeners, resize observers, media-query listeners, and timers are cleaned up on disposal. Changing the workload mounts a fresh graph.
- Separate HTML and Electron entries keep the experiment out of the normal renderer bundle. Knip explicitly recognizes the development entry, `src/investigation/demo/dev.tsx`.

The change is larger than a static graph demo because it includes the semantic fixture, replay state, inspector, presentation controls, two focused test suites, styling, and the isolated launch path. It does not add a feed transport or change existing task behavior.

## Initial horizontal-version findings

**CompactBox preserves sibling order but does rearrange unrelated branches.** A direct probe of the installed `@antv/hierarchy` 0.7.1 CompactBox function used by G6, using the story's navigation tree and the adapter's dimensions, produced these coordinates (before G6's viewport offset):

| Snapshot |   H1 y |  H2 y | H3 y |
| -------- | -----: | ----: | ---: |
| S0–S2    |   -162 |   -62 |   38 |
| S3–S4    |   -187 |   -37 |   63 |
| S5       | -199.5 | -24.5 | 75.5 |

H3 moves 25 layout units when E22 arrives under T4. Reserving the known replay layout prevents that movement during playback and scrubbing. A next increment must test positioning against genuinely unknown appends before approving live integration.

**Readable cards require choosing a viewing scale.** G6's label defaults truncate to one line; explicitly setting three lines preserves ID, status, and title. Fit-all text becomes unreadable as the tree grows. The inspector and Read selected action are necessary; a graph-wide overview is not a readable document. A smaller/custom card style, branch summaries, or a different tree orientation deserve testing before changing libraries.

**Selection and history are separate from attention.** The H3/S2 hold scenario retained H3 and the inspector when S3 arrived. Evidence corrections remain inspectable at their original snapshots. The native select required explicitly reapplying selection after its option list changed; otherwise the displayed selection could reset during backward scrubbing.

## Initial horizontal-version measurements

Directional measurements, not a benchmark or an efficacy study. Linux x86_64, Intel Core Ultra 9 275HX, 24 logical CPUs; Electron 40.8.5 / Chromium 144.0.7559.236; observed renderer viewport **1031 × 934 CSS pixels**, DPR 1.25 (the desktop constrained the requested window size). Vite development mode, no CPU throttling. Native CDP mouse/keyboard input exercised the Electron window. Browser checks also covered 1440 × 960 and 390 × 844 viewports, light/dark themes, and reduced motion.

The second timing pass waited for Fit to finish before recording results. Each burst accepts ten annotation revisions at once. Draw duration includes the configured 260 ms animation; frame intervals are a roughly 1.3-second `requestAnimationFrame` sample spanning the burst. These are frame-interval observations, **not compositor dropped-frame counts or input-latency percentiles**.

| Measurement                                 | 30 records | 100 records |
| ------------------------------------------- | ---------: | ----------: |
| Burst draw, including motion                |     283 ms |      282 ms |
| Selected movement during burst              |     0.0 px |      0.0 px |
| Frame interval p95                          |    16.8 ms |     16.8 ms |
| Maximum observed frame interval             |    16.8 ms |      100 ms |
| Frame intervals over 25 ms                  |     0 / 79 |      1 / 74 |
| Fit overview label size                     |     3.2 px |      0.7 px |
| Read selected label size                    |    13.0 px |     13.0 px |
| Read selected draw, motion disabled by hold |       7 ms |       16 ms |

The first pass also observed a 100 ms frame interval at 100 records, so the tail should be investigated before claiming smooth interaction. No renderer exceptions were observed. Camera movement caused by explicit Fit/Read selected is intentional and is included in the on-screen movement metric. That metric is sampled per draw; it is not a continuous camera/zoom profiler.

The normal frontend's main JS chunk was unchanged in name and reported size before/after: **6,827.80 kB / 1,870.44 kB gzip**, `index-C4scgtiI.js`. A separate production-mode build of the spike entry, forcing its development guard on solely for measurement, produced **1,440.58 kB JS / 416.40 kB gzip**, plus **58.53 kB CSS / 11.71 kB gzip** and fonts. This is the complete isolated entry, not G6 alone or a prediction of a shared application's incremental chunk size. Cold-load time and memory were not measured.

G6 is pinned to 5.1.1; its installed LICENSE is MIT. The lockfile gained 44 package entries. The audit on 2026-09-12 identified no advisories against those added entries; the repository still has existing advisories outside this addition.

## Historical G6 verification and decision

Passed: five reducer tests; four real-state client tests (canvas mocked at that boundary); TypeScript; ESLint for touched source; Prettier; Knip; dependency-cruiser; normal frontend production build. Electron exercised the actual canvas in addition to the mocked client tests. The full repository test suite was not run.

**Original G6 decision, superseded by the SVG comparison above:** continue the renderer experiment; do not yet approve live integration. G6 can render the narrative and preserve a held replay view without a separate renderer or layout implementation. The unknown-insertion layout problem, very small overview labels, and 100-record frame tail are still open. There is no evidence yet that switching to SVG fixes these; no second library was added. Task scoping, file-watch cleanup, untrusted JSONL validation, feed latency, source inspection, prompt delivery, and human comprehension/engagement comparison remain later stages.

Primary references checked during implementation: [CompactBox configuration](https://g6.antv.antgroup.com/en/manual/layout/compact-box-layout), [G6 animation configuration](https://g6.antv.antgroup.com/manual/animation/animation), [G6 license](https://github.com/antvis/G6/blob/v5/LICENSE), and [Electron ESM lifecycle](https://www.electronjs.org/docs/latest/tutorial/esm). API signatures and label defaults were also checked in the installed package sources/types.
