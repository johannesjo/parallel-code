# Agent coordination: actions, status evidence, and result handoffs

Status: Steps A and B implemented and verified. Step C is implemented and passes the recorded checks, but a fresh review found two open P2 defects after the initial review reported no actionable findings. Resolve these before accepting C. Steps D–E remain planned as separate changes. Updated 2026-09-26.

Step A extends the sidebar tray with independent questions, reviews, and coordination failures; shares child attention summaries; hydrates delegation state without panel mounts; and opens child reviews without resuming collapsed agents. Already-merged results retain an explicit review acknowledgment. Step B adds launch-bound hook observations shared by MCP and the renderer, ordered snapshot hydration, and activity provenance labels. Step C adds bounded completion reports, persistence and report display, plus schemas and structured results for the five selected MCP tools. Native Electron smoke testing has not been performed. Captured reviews and request changes remain separate work.

## Remaining work

Implement and validate each step separately; the scope and acceptance gates below are the handoff for future changes.

1. **C — Review corrections:** recognize prompt submissions inside coalesced terminal input, and validate session `land_self` input before landing so successful responses satisfy the declared schema. Add regression coverage for both findings recorded below.
2. **D — Captured reviews:** pin the displayed diff/files to Git objects, include the completion packet and app verification evidence in that snapshot, and reject approval of superseded assignments through the shared review revision.
3. **E — Request changes:** after D, submit feedback once to a verified, ready primary process with draft protection, revision invalidation, explicit outcomes, and no automatic retry.

D depends on C; E depends on both B and D. Finish the C review corrections before starting D. No later step is included in the completed milestones or their test results.

## Decision and scope

Implement the three selected improvements as incremental changes to the existing coordinator and desktop UI:

1. An action queue extending the existing Needs input tray, with child attention summaries.
2. Explainable activity evidence available to MCP and the UI.
3. Structured completion handoffs and a review surface bound to the displayed result.

The smallest complete solution reuses current task state, hook events, delegation messages, verification records, and review authorization. It does not require a new scheduler, notification database, workflow framework, or runtime extraction. The total implementation will exceed three production files and 100 changed lines because it crosses shared contracts, main, MCP, persistence, and UI. Split it into the independently testable steps below.

Excluded: combined-tree verification/merge queues, completed-task history after cleanup, durable message receipts, dependencies/file ownership, budget controls, phone UI changes, batch approval, automatic retry, additional providers' hook integrations, and a headless daemon. These belong to the unselected ideas or separate work.

## Evaluation of the existing implementation

| Area          | Existing behavior                                                                                                                              | Consequence for this plan                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Attention     | `sidebar-attention.ts` collects open questions; task attention chooses one prioritized status.                                                 | Collect actions independently so questions coexist with reviews/failures.                                |
| Parent rows   | `CoordinatorFolder` shows parent status and child count.                                                                                       | Add a separate child summary; never make a child's state look like the parent's own activity.            |
| Completion    | `signal_done`, process status, and landing state are separate. The hook `done` enum also covers session initialization and idle notifications. | Preserve those distinctions and interpret the originating event before labeling a turn finished.         |
| Status        | Renderer hook logic preserves unrelated parallel-tool waits and adds local input inferences; coordinator uses its own readiness logic.         | Share evidence rather than replacing both state machines.                                                |
| Hook identity | Hook events carry task/agent IDs, but no PTY launch identity.                                                                                  | Bind newly accepted hook evidence to a launch before presenting it as current.                           |
| Handoff       | `land_self` has typed verification/summary; `signal_done` takes no payload.                                                                    | Add an optional bounded completion report to the review path.                                            |
| Review        | Source/target SHAs are approved, but the diff is subsequently read through live `getTaskDiff`.                                                 | Generate every displayed review artifact from the captured Git objects.                                  |
| Verification  | App runs include HEAD and dirty-at-start data; agent checks are self-reported.                                                                 | Display the evidence classes separately and do not claim an exact verified tree when identity is absent. |
| Follow-up     | Coordinator prompt delivery resets completion after Enter; renderer prompt delivery does not; queuing leaves the old result active.            | Request changes needs a specific main-process operation.                                                 |
| MCP           | Tool discovery/authorization are already scoped; output is text, without output schemas.                                                       | Add structured results to selected existing tools; preserve authorization and text compatibility.        |

## 1. Action queue and child summaries

### Behavior

Rename the existing tray to **Needs attention**. An entry names its task/project, reason, and action. Show these sources:

| Reason            | Source identity                                                              | Action                                | Clears when                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Question          | task, asking agent, question onset                                           | Answer question: open the asking pane | The existing question state clears.                                                                                 |
| Review            | task and current completion identity; legacy fallback from task review state | Review result                         | Unintegrated approval is superseded or merged; post-integration review is explicitly acknowledged; task is removed. |
| Launch failed     | parent and delegation request ID                                             | Inspect launch failure                | Existing attempt dismissal or successful resolution.                                                                |
| Delivery failed   | delivery ID                                                                  | Inspect delivery failure              | Existing explicit failure acknowledgment.                                                                           |
| Integration issue | task and current landing failure/escalation                                  | Inspect integration issue             | Backend landing state resolves or task is removed.                                                                  |

Keep ordinary queued delivery out of the queue: a draft or busy recipient is not itself an error. Leave unrelated close-error and general session-error workflows in their existing surfaces for this increment.

Collect all reasons independently. A child with a question and a pending result gets both. Deduplicate equivalent review signals (`needsReview`, manual completion, latest `awaiting_review`). Suppress only obsolete pre-integration approval signals: `landed_pending_review` retains one review action until explicitly marked reviewed; `landed_cleanup_failed` remains an integration issue. A consumed coordinator completion notification is not human review. Expose all asking agents using a plural selector built on existing question detection; retain the current singular selector for its other callers.

Viewing changes navigation/unread state only. Never dismiss a failure, answer a question, or clear review merely because its row was opened. Already-integrated results use the existing explicit mark-reviewed action; unintegrated results merge through the ordinary Finish dialog.

Use source timestamps where present. Attempts without a recorded onset have no age label. Keep questions first with the existing newest-first order, then failures, then reviews; use stable source/task order for ties and keyed rows to preserve keyboard focus.

Include unresolved background tasks and tasks under collapsed project folders. Deduplicate active/collapsed task arrays; omit removed and actively closing tasks. Hydrate delegation snapshots through the existing startup/adoption flow and consume change events so visibility does not depend on mounting `DelegationPanel`. Do not add polling.

### Navigation and summaries

- Questions reuse the current jump helper, including stale-agent/panel checks.
- Open child review directly from tray-owned dialog state. Do not call `uncollapseTask` for passive review: it resumes agents.
- For a collapsed ordinary task whose existing surface requires a running task, label the action **Resume and open** explicitly.
- Failure rows navigate to the existing collaboration/landing detail. No automatic retry or submission.
- Parent rows and `SubTaskStrip` share one derived summary: count distinct children needing attention; show working children separately. A child with multiple actions counts once. Failed launch attempts have no child ID and receive a separate count. Exclude detached children.

### Main files

`src/store/sidebar-attention.ts`, `taskStatus.ts`, `sidebar-order.ts`, `delegation.ts`, `src/components/Sidebar.tsx`, `SubTaskStrip.tsx`, and `DelegationPanel.tsx`. Extract a small tray component only if owning result dialogs in Sidebar would increase its existing complexity.

## 2. Explainable activity evidence

### Contract

Keep coordinator `status` unchanged. Add optional `activityEvidence` to coordinated-task status and summaries, with:

- `agentId`, launch identity, source (`hook`, `terminal`, or `process`).
- Reported activity (`working`, `waiting`, `ready`, `turn_finished`, or `unknown`).
- Source event, observation time, and state-since time where known.
- Optional permission/question kind and the existing bounded human detail.
- Freshness (`current`, `stale`, or `unknown`).

This describes the primary coordinated agent. Renderer task attention can aggregate multiple panes; label the subject and do not claim that its aggregate equals the primary agent's state. Keep task completion and integration fields alongside activity.

Use a pure shared hook transition for matching-tool wait preservation and state timestamps, extracted from existing behavior. A main-owned bounded per-live-agent observation cache supplies MCP and accepted hook evidence to the renderer. Keep renderer unread bookkeeping and terminal-input inference local; those inferences must be labeled as such rather than attributed to a new hook event. Do not move terminal question detection, readiness, prompt sending, or chat status into a new state engine.

### Identity and lifecycle

Current hook IDs are insufficient to reject late events after an agent-ID-preserving restart. Add an opaque per-PTY-launch identity to hook environment/header/payload and compare it against the current launch before broadcasting or caching. Attach the identity to the existing PTY launch/session ownership; do not treat a CLI conversation ID as a launch ID or assume the MCP-only session identity is already on hook events.

Register identity before the child can emit hooks, retire it on spawn failure/exit, and guard retirement against clearing a replacement launch. Reattaching to an existing PTY preserves its identity and observations; only an actual new process replaces them. Late/missing/mismatched identities cannot revive activity. Add the new environment name to the existing protected hook environment set. Old or unsupported hooks fall back to labeled terminal/process evidence.

Renderer initialization subscribes to accepted hook updates, then reads the main cache through a small read-only snapshot IPC operation. Merge the snapshot without overwriting newer subscribed events or reviving a retired launch; use a monotonic observation sequence with the launch identity. Update the channel manifest, preload allowlist, and their tests if no existing snapshot route fits. No periodic polling or persistent activity database is needed.

Preserve the renderer's existing 30-minute ongoing-hook freshness threshold initially. A finished-turn observation remains a historical fact, while a new prompt/launch invalidates its use as current activity. Hookless agents and Docker retain their current fallback; show unknown source times rather than fabricated timestamps. Empty/reloaded caches are unknown until observed, not working by default.

Status tooltips show, for example, “Waiting for an answer · hook report · observed 20 s ago.” Local inference can say “Activity inferred from terminal input.” Derive labels from the event as well as the three-state hook enum: `SessionStart` means **Session ready**, an idle notification supports **Ready for input**, and `Stop` supports **Turn finished**. Preserve failure context for `StopFailure`. Neither a ready session nor a finished turn implies assignment completion or passing verification. Source metadata is diagnostic and must not itself grant permission or change scheduling/merge eligibility.

### Main files

`electron/agent-hooks/status.ts`, `events.ts`, `runtime.ts`, `server.ts`, `hook-script.ts`, `electron/ipc/pty.ts`, `electron/mcp/coordinator.ts` and `types.ts`; renderer `agentHookStatus.ts`, `taskStatus.ts`, `StatusDot.tsx`, and `TaskAgentStatusLine.tsx`. Keep new shared contracts renderer-safe. Reuse existing hook/task-state event channels; add only the missing read-only cache snapshot route.

## 3. Structured completion and review

### Completion report

Extend `signal_done` with an optional `result` containing summary, existing agent-reported verification checks, repository-relative artifact paths with optional labels, and unresolved issues. Preserve `{}` calls and show **No structured report provided** for legacy results. Do not manufacture checks or summaries from terminal output.

Main validates payload size and structure before mutating completion. Proposed bounds: 16 KiB total report, 4 KiB summary, 20 checks, 20 artifacts, 10 unresolved issues, bounded strings. Reuse existing verification types through a renderer-safe shared contract instead of adding a third copy. Artifact paths are data: no URL launching, shell execution, or arbitrary filesystem reads. Initially show/copy their paths; opening captured contents can be added through a separately scoped reader.

Capture a server-generated completion ID, timestamp, source commit, and dirty/unknown snapshot flag with the report. Read the source commit consistently and reject/report a moving HEAD rather than attaching a report to an arbitrary later commit. The commit is an association, not proof the reported checks ran against it. Capture the current review revision and task/session identity before asynchronous work, compare them before publication, and publish by advancing the revision synchronously. Overlapping completion captures cannot overwrite a newer publication. Legacy empty reports may complete without a Git snapshot; mark identity unknown.

Keep only the latest report on the task. Return it through status and completion wait; list responses may carry its compact identity/summary. Include it in existing task-state synchronization and normal task persistence/restoration. Do not promise crash durability beyond the existing save path or retention after automatic cleanup. Both active and collapsed restore paths must tolerate absent/invalid old data.

Handle session and legacy done routes with the same parser. Preserve done-token/session ownership, orchestration-off completion behavior, and caller scoping. Update both child guidance generators to request a concise report without copying runtime delimiter strings into project guidance.

### Review snapshot

> Superseded: review-policy children now merge through the ordinary Finish dialog, and `DelegationReview` was removed.

Extend `DelegationReview` to return one immutable display packet: source/target commit IDs, completion identity/report, captured changed files/diff, and available app verification evidence. Use captured commit objects for the cumulative diff and file inventory; do not call live `getTaskDiff`, mutable HEAD loaders, or live context expansion from the review UI.

Preserve the established merge-base comparison so unrelated target changes are not represented as child edits. Preserve runtime-guidance filtering using captured contents. Report truncation explicitly, including files omitted from the displayed diff; keep a refresh action. Never stage, commit, remove guidance, or write project files just to open a review.

If the current source commit differs from the report, mark the report stale and do not imply its checks describe the new source. App checks are labeled separately from agent claims. A missing SHA, dirty run, changed SHA, or unavailable record cannot earn a **Verified at this commit** label. The existing runner pins HEAD at run start; this does not prove the worktree stayed unchanged throughout execution, so avoid stronger claims than the stored evidence supports.

Start with summary, blockers, verification, frozen file inventory, and the existing raw diff with file-section navigation. Reuse pure verification formatting with stricter handling of unknown identity. Defer rich inline comments/normal `ReviewProvider` submission because they currently use live data and generic prompt sending.

Approval still binds displayed source and target commits under the repository merge lock. Add a task review revision to reject superseded results even when source HEAD has not changed. Returning a new snapshot must not silently grant approval. Merge remains desktop-only and invokes existing verification; combined-tree verification is explicitly outside this plan.

### Review revision lifecycle

Use one main-owned invalidation operation. A newly accepted follow-up assignment, successful new prompt submission, actual replacement of the primary agent, and a new completion publication supersede the previous revision. Reattachment preserves it. Coordinator prompt acceptance must invalidate before queued work can leave an older review eligible. Renderer sends must pass through the same invalidation boundary; clearing renderer flags alone is insufficient. Accepted `UserPromptSubmit` covers native hook-backed terminal prompts; hookless raw terminal submission must conservatively invalidate via the existing primary-agent input tracking. Focus, scrolling, and a secondary agent's input do not create a new primary assignment.

Wire this across coordinator sending, renderer prompt submission, primary PTY replacement, and completion publication. Do not duplicate invalidation logic across call sites. A review snapshot captures the revision, and approval checks it after async verification and again at the final merge boundary. Record supersession even if the code remains at the same SHA. An old capture/report cannot clear a newer superseded state.

For review-policy children, a superseded result cannot become mergeable merely because the primary is idle/exited or a new snapshot was opened. Require a fresh explicit completion for the current assignment, including a valid legacy empty completion. Display the old report as historical until then. Existing results without the new metadata retain the current legacy eligibility until a new assignment invalidates them. This gate is separate from `signalDoneConsumed` and must be checked by desktop approval as well as the existing integration-policy guards. Restore saved supersession normally, discard transient open-review authorizations on restart, and retain the existing save-path durability limitation.

### Request changes

Provide a feedback field inside the result dialog. Preserve it on error; never overwrite an existing terminal/chat composer draft.

Use a one-shot desktop-only `DelegationRequest` operation carrying a request ID, displayed review revision/source identity, current recipient identity, and feedback. Limit it to **unlanded review-policy children with a live ready primary PTY**. Automatic-policy and already-landed tasks keep their existing workflows; they cannot enter this rework state. Serialize submission with integration through the existing task integration exclusion.

Preflight checks the current snapshot/revision, payload size/control characters, recipient launch, prompt readiness, orchestration/pause state, existing pending prompts, human control, and terminal input. The renderer supplies the same draft-free delivery opportunity used for peer messaging and rechecks it before invoking the operation. Feedback lives in its own dialog field. If blocked, leave the current result unchanged, retain feedback, and show the concrete reason. There is no background feedback queue, automatic resume, or delayed submission after the user leaves.

Use the existing session-pinned `writeAgentPrompt` helper, plus readiness checks comparable to peer delivery. Do not call `sendPrompt`/`flushNextQueuedPrompt`: those paths lack the required readiness/session guarantees and can retry. Once the writer has acquired a safe submission opportunity, invalidate the review before the first body write and suppress old completion notifications. Recheck recipient, orchestration, revision, and cancellation immediately before body and Enter. Preserve the writer's arbitration of simultaneous terminal input.

Set a transient submission-in-flight exclusion synchronously before invalidation. Completion publication must reject while it is held, including captures that start after invalidation and otherwise see the new revision. Clear the exclusion only after submitted/failure state is finalized; failures leave the result superseded. Older captures still fail their revision comparison. This is an in-memory critical section around one submission, not a persisted pending-delivery gate.

Return **submitted**, **not ready**, or **failed/unknown submission** explicitly. A repeated accepted request ID returns its existing runtime outcome; changed feedback under the same ID is rejected. Before-any-write rejection does not supersede the result. A failure after submission begins leaves the old result superseded, retains feedback in the dialog, and requires user inspection before a deliberate retry. Never automatically resend after an ambiguous Enter failure. Lost receipts across app restart remain unknown; do not claim durable exactly-once delivery.

After submission, keep the child in the current assignment awaiting a fresh completion. There is no persisted “waiting for delivery” gate: progress cannot depend on a volatile queued prompt or receipt. Store only ordinary result/supersession state through the existing persistence path. On exited recipients, explain that the user must explicitly resume first. Do not create follow-up tasks for already-landed work.

This operation must land with its invalidation/delivery tests; a composer-only shortcut is not an acceptable partial implementation. The ready-only restriction is the deliberate simpler alternative to a recoverable feedback queue.

### MCP structured responses

Add `outputSchema` and `structuredContent` for `get_task_status`, `list_tasks`, `signal_done`, `land_self`, and `wait_for_signal_done`. Cover session and legacy dispatch. Preserve existing text content; wrap the list only in structured output as `{ tasks: [...] }`. Keep wait timeout/no-remaining variants valid. Use a common result formatter and the existing tool selection so output contracts do not bypass role filtering.

Errors remain `isError: true` with text, without a success-shaped structured payload. Normalize a rejected `signal_done` result into an error. Installed MCP SDK supports structured results, but this low-level server does not automatically validate them: validate against the declared schema with the installed SDK's schema validator in focused contract tests. No new dependency or MCP server framework migration.

### Main files

`electron/shared/delegation-types.ts` plus one shared completion contract if needed; `electron/mcp/types.ts`, `coordinator.ts`, `delegation.ts`, `client.ts`, `server.ts`, `mcp-tool-list.ts`, `preamble.ts`, `sub-task-preamble.ts`; legacy done handling in `electron/remote/server.ts`; restore wiring in `electron/ipc/register.ts`; `src/store/types.ts`, `tasks.ts`, `persistence.ts`, `delegation.ts`; `DelegationReviewDialog.tsx` and existing diff/verification helpers.

## Delivery sequence and acceptance gates

| Step | Deliverable                                                           | Gate                                                                                                                                                                                          |
| ---- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | Derived action queue and child summaries using current state          | All action sources work without mounting task panels; viewing has no resolution or launch side effects.                                                                                       |
| B    | Launch-bound activity evidence and provenance labels                  | A late hook from a replaced launch cannot change new activity; UI/MCP expose the same underlying hook observation and disclose local inference.                                               |
| C    | Optional structured handoff, persistence, selected MCP output schemas | Old callers/saves work; malformed reports mutate nothing; both transport paths return schema-valid successes and real errors.                                                                 |
| D    | Captured review packet and file navigation                            | Diff, report association, and displayed verification identity are explicit; changed source/target invalidates merge; reading has no writes.                                                   |
| E    | Ready-only Request changes                                            | Blocked feedback stays in the dialog; started/failed submission invalidates old approval; no background queue, draft overwrite, duplicate runtime delivery, implicit resume, or unsafe retry. |

A can ship independently. C precedes D; D precedes E. B is independent of C/D, but E must use a verified recipient launch identity. Add report-aware action identity to A as C/D land. Avoid parallel edits to the coordinator or shared contracts across these steps.

## Verification plan

Extend existing tests for meaningful behavior rather than duplicating every new field:

- **Queue:** simultaneous question/review/failure; two asking panes; consumed notification still awaiting human review; automatic landing retains post-integration review until explicit acknowledgment; cleanup failures stay visible; equivalent review sources deduplicated; background/project-hidden tasks; detached/removed children; distinct child counts; unknown ages; stable keyboard focus; passive review never calls resume or sends input.
- **Source hydration:** failure generated before any collaboration panel mounts becomes visible; initialization/change-event ordering does not overwrite newer state; removed tasks are not resurrected.
- **Activity:** matching versus unrelated parallel tool results; permission/question transitions; local interrupt/approval inference labeled honestly; stale hook fallback; hookless and Docker behavior; same-ID restart and delayed old hooks; reattachment preserves identity; spawn failure; exit/late stop; cache snapshot/event ordering during renderer reload; SessionStart and idle notification never labeled as a completed turn; Stop/StopFailure never imply completed assignment.
- **Completion:** empty legacy call; bounded report; invalid path/shape/size; no partial mutation; cross-task and expired-session denial; source changing during capture; current-versus-stale report; both wait variants; repeated/overlapping reports; same-HEAD follow-up through renderer/coordinator/native-terminal paths; replacement versus reattachment; optional fields fully replaced rather than Solid's deep-merge retaining old fields.
- **Persistence:** old saves, valid new report, malformed fields, active/collapsed restoration, and superseded state across reload. No persisted pending delivery can strand completion. Activity evidence and open-review authorizations remain transient.
- **Review:** pinned source/target diff with uncommitted changes and moving branches; rename/binary/large/truncated diff; runtime-guidance filtering; absent/dirty/stale verification; exact displayed approval identity; concurrent source/target change; parent closure; refresh does not silently approve.
- **Rework:** race with approve/verification; not-ready and human/draft holds mutate nothing; body/Enter write failure; request ID reuse; recipient restart/exit during paste; late old completion; completion capture starting after invalidation but before Enter cannot publish or reopen eligibility; new snapshot cannot bypass supersession; automatic-policy entry rejected; feedback retained; no queue/replay/implicit resume; no generic composer submission.
- **MCP:** schema validation for five selected tools in ordinary/child/legacy profiles; list wrapper compatibility; error results without structured success data; malformed input; role authorization unchanged.

Relevant suites: `sidebar-attention.test.ts`, `sidebar-order.test.ts`, `agentHookStatus.test.ts`, `taskStatus.test.ts`, `tasks.test.ts`, `persistence.test.ts`, `delegation.client.test.tsx`, `Delegation.client.test.tsx`, hook server/script/status tests, `coordinator.test.ts`, `coordinator-delegation.test.ts`, `delegation.test.ts`, `server.test.ts`, `mcp-tool-list.test.ts`, and remote session/done-route scoping tests. Add focused cases where no existing UI test owns the new behavior.

For implementation, run focused suites, then `npm run check`, `npm run check:static` for changed shared exports/dependencies, and the relevant unit/client suites. Run the real-PTY coordinator test for hook/rework delivery changes. Smoke-test native desktop with two children, a question plus review, failed delivery, source change during review, a blocked then explicitly resubmitted Request changes operation, and a same-ID restart. Report unavailable native/PTY verification. No paid real-agent suite is required by default. The hook snapshot IPC addition requires manifest/preload updates and the allowlist test.

Step A has passed `npm run check`, `npm run check:static`, and the full unit/client suites (4,948 tests passed; 33 opt-in or otherwise skipped tests). The full suites were rerun after the implementation-review correction. These results cover the first milestone only. Native Electron smoke testing remains unperformed; the later hook/rework steps still require their real-PTY and native checks.

Step B has passed `npm run check`, `npm run check:static`, and the full unit/client suites (4,995 tests passed; 33 opt-in or otherwise skipped tests). The real-PTY coordinator suite also passed all 9 tests. Full tests required execution outside the sandbox because local socket binding and some Git subprocesses were blocked with `EPERM`. Native Electron smoke testing remains unperformed; no paid real-agent suite was run.

Step B preserves hook observations across reattachment, rejects late events from replaced/retired launches, invalidates finished activity on prompt submission, and shares matching-tool wait reduction and source timestamps. Renderer snapshot ordering covers newer subscribed events, retired launches, and missed retirements while unsubscribed. Local interrupt/approval inference remains renderer-owned and labeled. Working hook evidence expires from UI activity after 30 minutes and falls back to labeled terminal/process inference; MCP retains the cached hook observation with `freshness: stale`. Waiting evidence never expires, because a blocked agent stays silent until someone answers. A failed turn stays failed through Claude's idle reminder until the next turn starts. Session readiness, input readiness, turn completion, and failure are distinct labels, independent of assignment completion. Static dot tooltips use absolute observation times; the existing clock-driven status line uses relative ages.

Two independent Step B implementation reviews found a P2 provenance defect (reducing main observations again against local interrupt state) and a P3 tooltip defect (nonreactive terminal observation timestamps). Both are corrected: accepted main observations replace hook fields directly while preserving local unread/suppression handling, and terminal timestamps are reactive and cleared on replacement/cleanup. Regression tests also cover a newer snapshot replacing an older tool wait. Both reviewers' isolated reproductions now pass, along with 186 focused unit tests and the full client suite (1,123 passed; 6 skipped).

Step C uses one renderer-safe completion contract and parser for both transport paths. It bounds UTF-8 bytes, checks, artifacts, and unresolved issues; artifact paths remain inert repository-relative text. Structured reports capture HEAD before and after the dirty-state read and reject a moving source. Empty legacy calls retain unknown source identity. Publication compares task, launch, caller, and review revision after asynchronous capture; a new publication, queued coordinator assignment, primary prompt submission, or replacement cancels an older capture. Reattachment preserves it. Reports and revisions survive active/collapsed restoration, replace whole renderer packets, replay on hydration, and accompany early task adoption. Attention entries use completion IDs. The current dialog labels agent claims, unknown/dirty commit associations, and historical/stale reports.

Step C does **not** implement the Step D approval gate or frozen review packet. The revision already prevents stale report publication, but D must also enforce assignment supersession at approval and final merge, suppress obsolete completion notifications, bind all displayed artifacts to the captured commits, and keep the report displayed with that review snapshot. E still requires its submission exclusion and delivery tests. The implementation spans the planned MCP, main, persistence, and UI boundaries without new dependencies or a server-framework migration.

Step C passed `npm run check`, `npm run check:static`, the full unit/client suites (5,104 passed; 33 opt-in or otherwise skipped), and all 9 real-PTY coordinator tests. Focused coverage includes schema validation through the installed MCP SDK, malformed legacy JSON, token/session expiry during capture, overlapping publications, changed HEAD, new assignments versus reattachment, early completion adoption, active/collapsed restoration, and actual Solid-store packet replacement. Native Electron smoke testing remains unperformed; no paid real-agent suite was run.

A subsequent fresh review found two P2 defects, independently reproduced and still open:

- **Coalesced terminal submission:** `TerminalView` batches input for 8 ms, but `writeSessionInput` emits `prompt-submitted` only for a separate Enter chunk with an existing draft. A chunk such as `follow-up\r` submits without advancing the revision, allowing an older report to remain current or an in-flight capture to publish after a hookless follow-up. Detect submission within the input stream while preserving bracketed-paste handling.
- **Session landing output contract:** session `land_self` bypasses the legacy input parser. A check containing only `result: "passed"` can land successfully and be echoed without the `name` and `command` required by the new output schema. The loose session input validation predates C, but its schema-invalid success violates C's contract. Validate before landing side effects and test the actual coordinator result with the SDK validator.

## External references behind the selected patterns

- [Herdr status authority and explanations](https://herdr.dev/docs/agents/): explicit source evidence and workspace rollups.
- [cmux feed](https://github.com/manaflow-ai/cmux/blob/main/docs/feed.md): actionable agent requests.
- [MCP structured output and schemas](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#structured-content): additive machine-readable results with text compatibility.

These references inform the design; they do not establish measured productivity gains for this app.

## Adversarial review

An independent GPT-6 Astra reviewer inspected the draft and relevant code. Its initial verdict was **revise**, with one P1 and five P2 findings. The primary agent checked the cited paths and accepted all six:

| Finding                                                                                             | Verified evidence                                                                             | Revision                                                                                                                                  |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| P1: review invalidation covered rework but missed ordinary prompts/restarts and overlapping reports | `coordinator.ts` prompt writer/spawn listener; renderer `tasks.ts` prompt path                | One revision lifecycle across submission/replacement/publication; compare before publishing captured results; same-HEAD regression tests. |
| P2: persisted pending rework could outlive its volatile feedback queue                              | `discardAutomatedPrompts`, `stopChildren`, renderer hydration omitting `pendingPrompts`       | Removed queued rework and its persisted delivery gate.                                                                                    |
| P2: coordinator prompt writer lacks the promised readiness/session/retry guarantees                 | `sendPrompt`, `flushNextQueuedPrompt`, `writePromptToTask` versus `pty.ts` `writeAgentPrompt` | Ready-only one-shot submission through the existing guarded PTY writer.                                                                   |
| P2: clearing review on integration would hide results awaiting human acknowledgment                 | `syncLandingState`, `markTaskReviewed`                                                        | Preserve `landed_pending_review`; show cleanup failure separately.                                                                        |
| P2: cleared completion flags do not prohibit all integration paths                                  | `assertTaskCanBeMerged`, `landSelfUnchecked`                                                  | Explicit supersession eligibility gate; Request changes limited to review-policy children; fresh snapshot cannot bypass it.               |
| P2: hook `done` also represents SessionStart/idle notifications                                     | `mapClaudeHookPayload`                                                                        | Event-specific ready/finished labels and initialization tests.                                                                            |

The review also supported keeping status work to launch-bound observations, shared hook reduction, and ordered snapshots. It favored the one-shot feedback operation over durable rework machinery. Its closure check accepted the six original revisions and found one additional race: completion could start after rework invalidation and publish during the writer's paste delay. The primary agent verified the asynchronous write gap and added transient submission exclusion plus a targeted test. The reviewer then confirmed **ready for implementation**, with all findings closed at the planning level. Implementation tests remain required; a reviewed design is not a verification of implemented behavior.

### Step A implementation review

A fresh GPT-6 Astra subagent reviewed the first milestone's complete diff, new files, and surrounding restoration, navigation, collaboration, and merge paths. It found one P3 issue: tied actions were ordered by generated IDs instead of source/task order. The primary agent verified the regression against the former tray, removed the ID tie-breaker, and added a test with reverse-lexical task IDs and equal question timestamps. The reviewer confirmed the correction closed its finding, with no remaining findings and no P1/P2 defects identified. Its focused review run passed 252 tests; the final full-suite results are recorded above. Native Electron focus/layout behavior remains outside the completed verification.
