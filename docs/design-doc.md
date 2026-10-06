# Cross-agent coordination

Status: V1 delegation and V2 automatic peer messaging implemented in this working tree. Existing sessions keep their launch-time tools; enabling new tools requires a conversation-preserving restart where supported. Native Electron smoke tests use isolated worktrees and local fake agents. Docker and real-provider compatibility require separate validation.

Latest product direction: users should orchestrate from their current agent terminal through MCP, including asking an agent to coordinate existing open tasks. The dedicated delegation dialog has been removed. Peer prompts queue for automatic submission when the exact recipient is ready. Existing project-level peer permissions still govern unrelated tasks.

## MCP settings

Settings has a dedicated **MCP** tab containing **Allow agents to orchestrate tasks** and the automatic child-update delay. There is no Coordinator mode setting or new-task preset. The global orchestration switch defaults on and is the sole creation enable control. Fresh eligible ordinary sessions expose `create_task` without a separate project opt-in. The old project creation flag is retired; existing saved values do not override this switch. Project-level peer-access permissions still apply.

Turning orchestration off immediately denies further agent orchestration requests, including requests from already-running ordinary and legacy coordinator sessions. It cancels pending launches, discards queued automated prompts, closes unhandled peer messages, and holds coordinator result notifications for review. Re-enabling does not replay discarded prompts or canceled launches. A terminal paste already started cannot be undone; its delayed Enter is suppressed. Git operations already issued may finish.

Running terminals and worktrees remain intact. Direct user input, child completion reporting, canvas tools, manual restarts, and desktop review/merge remain available. Trusted phone task creation remains available, but automated coordinator prompt delivery stays off.

The backend also defaults orchestration on. Persist the switch in app state and apply it in main before restoring sessions; stale renderer saves cannot override the backend policy. The checkbox changes only after backend acknowledgment. Sessions launched with tools omitted while disabled need a restart to acquire those tools after enabling; use the existing conversation-resume path where supported. No automatic restart is performed.

## Product direction and release boundaries

Let ordinary Parallel Code tasks delegate work without a dedicated coordinator task or a user-supplied `--coordinator-id`. Later, let agents discover eligible sessions and exchange prompts. There is no universal default coordinator: merely starting a session does not register a parent, inject backlog-processing instructions, or start children.

**V1 ships delegation:** agent-initiated task creation through MCP for supported fresh sessions, review-required results by default, explicit per-task automation options, existing child supervision, and complete parent lifecycle. Peer discovery and messaging do not block this release.

**V2 adds peer discovery and queued messages:** exact recipients, automatic delivery when ready, a pending-message inbox, restricted access, and delivery receipts. Recursive delegation, cross-project access, and durable messaging remain separate follow-ups.

V1 supports top-level Git worktree tasks. Shell panes cannot initiate agent operations. Coordinated children retain completion tools but cannot create grandchildren; explain that restriction in their MCP instructions. Direct-checkout and non-Git delegation are deferred. Agent-initiated delegation requires app-provisioned tools and credentials; chat-backed and unsupported custom-agent tool integration is deferred.

The agent terminal is the task-creation interface. When a user asks for a Parallel Code task or PC task, use the app's `create_task` MCP tool, never substitute a native CLI sub-agent. Report success only after the tool returns an app task ID. There is no dedicated delegation button, assignment dialog, or desktop creation IPC endpoint.

New worktree tasks expose **Agent automation** in their advanced options: **Automatically merge completed child tasks** (`autoMergeChildren`) and **Automatically send child updates** (`autoSendChildUpdates`) both default off. The same section configures child concurrency and explicit permission-bypass propagation. Concurrency defaults to four and can be changed later from the parent's collaboration panel; propagation defaults off. The user supplies backlog-processing or orchestration instructions in the ordinary task prompt. Creating a task does not inject a coordinator preamble or eagerly start a dedicated coordinator MCP server.

The persisted `coordinatorMode` marker is deprecated and retained only to restore existing tasks with their legacy transport and behavior. New tasks cannot request it. The old global `coordinatorModeEnabled` setting is ignored on restore and is no longer saved; it does not initialize the coordinator backend. Existing legacy task restore/retry paths remain available.

Settings > MCP explains that children launch additional agent sessions that may incur provider charges, and shows the shared default concurrency limit of four. This is a concurrency limit, not a spending cap. The global orchestration switch controls task creation; unrelated peer access retains its separate per-project setting.

Check the global orchestration setting in the backend on every request and again before starting a reserved launch. Disabling it blocks new ordinary-agent creations without abandoning existing children. Show child counts and **Stop all children** on each parent. Stop first pauses that parent's automated creation/restart and cancels pending launches, then stops its children while preserving worktrees; only an explicit user resume re-enables launches. Do not introduce per-tool-call consent dialogs while orchestration is enabled.

Replace terminal-regex spawning with explicit MCP calls. Do not interpret arbitrary output as an instruction, suppress terminal input, or launch agents because prose matches a pattern.

## V1 user experience

### Create from the current agent terminal

The user asks the current agent to create one or more named Parallel Code tasks with concrete assignments. The agent calls `create_task` with a request ID, name, prompt, and any explicit snapshot choices. The app creates visible child tasks using the parent's project and supported agent configuration.

Children receive a committed snapshot, not the parent's conversation or uncommitted edits. Include the required context in the prompt. Never silently stage or commit files. A dirty parent produces a clear error with the changed-file count. The agent can explicitly choose `useLastCommit:true` when omitting those changes matches the assignment, or ask the user to review and commit first.

Capture the selected base commit and parent branch at submission. The backend validates both and branches from that commit; if branch/HEAD changed before creation, refresh the choice instead of silently using a different snapshot. Add a separate snapshot-commit field for worktree creation; keep `task.baseBranch` as the integration branch and preserve the existing merge-base-based diff calculation. Do not replace the branch field with a SHA and thereby change what the merge path reads. Agent-initiated requests receive a clear dirty-parent result and may explicitly choose the current committed state; an MCP call never implicitly authorizes a commit.

Use one MCP call per child, without an additional confirmation dialog for each call. Preserve explicit permission-bypass propagation settings, defaulting off for ordinary parents. Do not derive permission bypass from inherited CLI arguments.

### Progress, review, and results

Children of ordinary tasks use **Review before merging** by default. When the parent explicitly enables `autoMergeChildren`, newly created children receive the `automatic` integration policy instead of `review`. The backend chooses and stores that policy, returns it in creation results/status, and generates matching child guidance. Existing saved legacy coordinators retain their integration default. Automatic child integration does not grant the ordinary parent legacy merge/close tools.

Review-required children commit and verify their work, then call `signal_done`; they are not instructed to call `land_self`. Automatic-policy children may call `land_self` after the existing verification and ownership checks. Enforce the policy in backend landing/merge handlers too. For review-policy children, approval is a user action on the particular result and target, not an agent-supplied boolean. Changed child commits or a changed integration target invalidate approval.

Reuse the child strip and sidebar grouping for any parent with children. Show starting, working, needs input, awaiting review, completed/integrated, and failed states from actual backend state. An idle agent is not proof of completion, and completion is not proof of integration. Provide **Open**, **Stop**, review/merge, and applicable recovery actions.

Show a transient assignment-attempt row before a live task exists. The existing child-created event is emitted after spawn; retain a failed attempt with the error and cleanup status for the current app run rather than making it disappear. Never label an absent PTY as running.

Completion/blocker summaries appear in the task UI and through existing list/status/wait tools. With `autoSendChildUpdates` off, staged summaries await explicit review/acknowledgment and do not type into the parent terminal. With it on, use the existing delayed automatic child-update delivery with draft/activity holds and the global orchestration gate. The effective policy is `autoSendChildUpdates ?? coordinatorMode ?? false`: an explicit false overrides the legacy fallback. Keep this independent of merge policy and legacy transport. Preserve outcomes after self-landed children leave the active list. Peer prompt delivery is independent of automatic child updates; it uses the orchestration switch and existing relationship permissions.

## Architecture: build on existing ownership

### Credentials and launch identity

Extend `canvasAgents` in `electron/remote/server.ts`; do not create a parallel credential registry. Its existing main-process record already binds a token to a task, agent, and liveness check. Add the session's project membership, launch-instance identity, and a capability set decided at mint time. Legacy canvas registrations default to canvas-only rights. Update the existing token classification/route checks to consult those capabilities, retaining one registry and one revocation path.

Use the existing `pendingSpawns` / `canvasOwners` ownership object in `electron/ipc/register.ts` as the launch identity source. Add an opaque `sessionInstanceId` to that object and carry it through registration and active-session metadata. Do not invent a separate generation registry. The pane's `agentId` and the CLI conversation ID may survive a restart; neither identifies this particular PTY launch.

`registerCanvasAgent()` currently returns the existing token when task and agent IDs match. Change that behavior: reattachment to the same live instance may reuse its token; a replacement launch must mint a new token and invalidate the old one. Instance guards already exist in spawn-failure cleanup and PTY exit handling; preserve and regression-test them rather than building a new revocation mechanism. The credential change is rotation on replacement and carrying the existing ownership identity through registration. Preserve existing `isActive` users and canvas-only sessions outside this feature.

Ordinary sessions launch without `--coordinator-id`. For capability-bound session credentials, ignore `X-Coordinator-Id` as an authority source and resolve ownership from the record. Keep existing coordinator-token/header validation and phone/REST routing intact. In particular, `REST_COORDINATOR_SENTINEL` and `defaultCoordinatorTaskId` remain for existing authorized legacy routes; new session operations must not fall back to them.

New child sessions need their existing completion scope and the appropriate session capabilities. Compose those tools without giving children the full coordinator set. Preserve legacy subtask, coordinator, mobile, and paired-device credentials under their existing rules. Do not put bearer credentials in renderer task state, logs, shared URLs, or persisted parent records.

### Authoritative project and task membership

Neither `getAgentMeta()` nor the renderer-pushed display `projectName` currently establishes project membership. Add a separate main-process `taskAuthority` map, owned by IPC registration/lifecycle code, for `(taskId, projectId, projectRoot, worktreePath, parentTaskId)` and lifecycle state. Do not extend `taskContext`: that display map is cleared and rebuilt by each `Remote_UpdateTaskStatus` broadcast. Partial, missing, or reordered display broadcasts must never grant or revoke authority.

The trust boundary is explicit: the desktop renderer and validated Electron IPC are trusted to supply the app's project/task identities; agent-facing HTTP callers are not. Project records currently live in renderer state; asking the renderer for them again is not an independent security check. Do not claim an independently loaded main-process project catalog. Register/update authority only on acknowledged create, import, restore, detach, and close lifecycle operations; backend-created children register directly. Complete registration before minting delegation capabilities, and reject conflicting updates rather than replacing the whole map.

Independently validate paths and Git ownership in the main process: resolve canonical paths, confirm the directory is a registered worktree of the supplied project repository using Git's worktree/common-directory metadata, and validate the branch/snapshot. Newly created worktrees must also satisfy the existing managed-path rules. Do not require every imported worktree to be beneath `projectRoot`; legitimate external worktrees are supported. HTTP request bodies and display-name broadcasts cannot supply or alter authority records.

If context is missing, conflicting, closing, or not restored yet, fail closed for delegation/peer operations; canvas-only access may continue under its existing rules. Removal and detach update this registry before new requests can observe the old relationship. Do not infer membership from an agent's current working directory or a display name.

### Access rules

| Operation                        | Required authority                                                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canvas tools                     | Own task, preserving current behavior.                                                                                                                                                                                          |
| Create child                     | Eligible top-level owning task; validated project, snapshot, and branch. No nested creation.                                                                                                                                    |
| List/status/wait/manage children | Own direct children, with existing ownership checks and the integration policy. Empty child lists are valid.                                                                                                                    |
| Merge/close/land                 | Operation-specific ownership and verification. Review-policy child integration additionally requires user approval. Peer rights confer none of these.                                                                           |
| V2 discovery/output              | Only recipients in the caller's allowed relationship/scope; permission checks apply to discovery as well as reads.                                                                                                              |
| V2 prompts                       | Children may contact only their own parent. Top-level tasks may contact their own children. Unrelated top-level peers require a project-level opt-in. Peer prompts wait for a ready recipient with no user draft or input hold. |

In V2, **Allow peer access between tasks** defaults off and explicitly enables discovery, output access, and automatic messages between eligible top-level sessions in that project. It does not expand a child's scope beyond its parent. No cross-project grants in this design. Treat output and prompts as untrusted peer content, not system instructions.

### Exact V1 tool exposure and completion loop

Use these named sets in `selectTools()` and capability-based dispatch. Tool discovery is not the security boundary: HTTP handlers enforce the same scope and current consent/policy, including calls to hidden or legacy handler names.

| Capability/profile                          | Advertised tools                                                                                                                                                                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Own-task canvas                             | `mindmap_read`, `mindmap_update`, `reasoning_read`, `reasoning_update`, `canvas_open`.                                                                                                                                                        |
| Ordinary top-level child supervision        | Canvas tools plus `list_tasks`, `get_task_status`, `get_task_output`, `get_task_diff`, `send_prompt`, `wait_for_idle`, `wait_for_signal_done`, scoped to own direct children. No parent registration is needed for an empty list/wait result. |
| Ordinary agent creation enabled at launch   | Supervision tools plus `create_task`, subject to the global orchestration and parent pause gates on every call.                                                                                                                               |
| Review-required child                       | Canvas tools plus `signal_done`. Do not advertise `land_self` or any create/manage-child tools; reject those calls server-side as well.                                                                                                       |
| Child under an automatic-integration policy | Canvas tools plus `signal_done` and `land_self`, with current ownership/verification rules.                                                                                                                                                   |
| Restored legacy coordinator                 | Canvas tools plus the current coordinator set: `create_task`, `list_tasks`, `get_task_status`, `get_task_output`, `get_task_diff`, `send_prompt`, `wait_for_idle`, `wait_for_signal_done`, `merge_task`, `close_task`.                        |

Ordinary parents do not receive `merge_task`, `close_task`, or the unadvertised `review_and_merge_task` handler. Review-policy integration and parent-requested cleanup use explicit desktop actions; automatic-policy children can use their scoped `land_self` tool. Disabling orchestration blocks further agent supervision calls as well as creation; manual review and child completion remain available. Newly enabled creation tools follow the restart rollout below; a still-running session never acquires authority merely by inventing a tool name or header.

Ordinary agents use `wait_for_signal_done` as their primary completion loop: inspect `list_tasks`, wait for an unconsumed child completion, then inspect that child's status/diff and report its review-ready or integrated outcome. For this profile, use a 30-second default and 60-second maximum timeout. On timeout, inspect status once for failure/blocker changes, then wait again if work remains. Do not repeatedly poll status or resend assignments. `wait_for_idle` is only for readiness after a follow-up that was actually sent, not task completion. Its ordinary-session timeout uses the same bounds; guidance requires at least 10 seconds between unchanged status checks when no blocking wait is available.

Expose the wait tool without requiring `--coordinator-id`; bind it to the caller's owning task and lazy parent record. With no children, return an empty result immediately and instruct the agent to stop waiting. Receipt/consumption of a completion is not merge approval: `remaining === 0` does not mean all results are integrated, and multiple panes must reconcile against `list_tasks` rather than assume every pane receives every completion event.

Gate wait suppression in `stageBatch`, `beginSignalWait`, and completion-consumption helpers on the effective automatic child-update policy. With automatic updates off, active waiters and consumption must not clear or suppress the visible review queue: waiting agents can consume completion events while the user still sees the result until explicit UI acknowledgment/review. With automatic updates on, retain the existing suppression behavior, including the legacy fallback. Update ordinary tool descriptions and launch guidance to teach this loop without importing the backlog preamble.

## V1 backend workflow and lifecycle

### Shared creation and admission

Expose child creation through the MCP-backed HTTP request and shared main-process delegation service. Desktop IPC manages acknowledged authority, settings, and lifecycle actions, without a dedicated child-creation dialog or endpoint. The UI does not require the parent's MCP token or call `store/tasks.createTask()` to create a top-level substitute.

1. Validate task/project membership, eligibility, the global orchestration setting, parent pause state, assignment, child agent, permission settings, and the chosen base snapshot.
2. Lazily register the parent using explicit project/root, branch/worktree, launch defaults, environment-file reference, verification command, and integration settings. Pass these settings directly to `registerCoordinator()` instead of racing mutable `setDefaultProject()` calls. Repeated registration must not reset existing state.
3. Reserve concurrency, publish the in-memory starting attempt, and call the shared coordinator creation path. Retain existing worktree validation, prompt delivery, and best-effort cleanup.
4. Publish the child-created event with its explicit parent relationship and link the attempt to the task. Return the child task/agent IDs and effective `integrationPolicy`.

Use the parent's configured concurrency or the shared default of four; permission-bypass propagation remains explicit and defaults off. Apply admission to creation, restart, restore, and recovery: restarting an exited child cannot reclaim a slot already used by another child. Do not release a failed child's capacity while its PTY remains alive. Surface capacity errors; do not add a hidden creation queue or descendant-budget system.

For duplicate tool calls and lost HTTP responses, use parent-task-scoped request IDs with an in-memory map of pending operations/results. Repeated IDs join/return the same operation; differing payloads fail. Disable repeat submission in the UI. Retain compact results for the current app run until that parent closes; requests against a closed parent fail rather than replaying an old operation.

Do not build a persistent creation-attempt journal in V1. After an app crash, never replay an unacknowledged creation automatically. Explain that an untracked worktree may remain and direct the user to the existing worktree import/inspection workflow (`ImportWorktreesDialog`). Reuse normal deletion/cleanup only after the user chooses to remove a verified candidate, preserving symlink handling in `worktree-cleanup.ts`. Import recovers work; it does not guess the old parent or automatically rerun the assignment. This explicitly trades automatic crash recovery for a smaller implementation.

### Restore and close belong to the backend

Persist ordinary-parent automation options, concurrency, permission propagation, child relationships, and integration policy using the existing atomic-write helpers. Restore and validate task authority, worktree/branch ownership, and parent relationships before hydrating coordinator state or admitting recovery launches. A stale saved MCP path is not authority. Credentials and launch handles stay private runtime state; child MCP launch arguments reference private credential files rather than exposing bearer secrets in renderer-visible state.

Closing a parent with children keeps the existing explicit warning that children become independent tasks. Move detach-and-close orchestration into the main process: the renderer requests one operation and renders progress. The backend marks the parent closing, blocks creation/restart, waits for or safely blocks in-flight landing, disables old parent-targeted integration/notifications, persists child detachments, and only then removes the parent worktree.

The Finish dialog's merge option disables merge-and-cleanup for delegation parents, and the backend rejects that combination before merging. Merge first, then close the task through the detach flow; direct Git cleanup must never bypass it.

Detach every affected child from the authoritative task registry, including children absent from the coordinator runtime map, and revoke the old relationship capabilities for every live pane of each child. A second pane must not retain parent access or completion/integration authority after detach. Serialize these relationship changes with app-state saves so a stale renderer snapshot cannot restore the old parent link. Git deletion is not atomic with persistence: if deletion fails after detach, retain the parent with a visible cleanup error and children safely independent; retry is idempotent. A renderer crash must not be able to leave children targeting a deleted parent. Do not retarget merges to main or delete child worktrees as an implicit consequence of closing the parent.

If the parent agent exits, keep the task and child results available. Multiple panes share task ownership, but unsolicited notifications must not jump to an arbitrary replacement pane. Summaries remain task UI state when automatic child updates are off; sessions can always explicitly inspect their task's results. When the parent branch changes, pause integration for user review rather than retargeting it silently. Detached children keep their work and finish independently; enabling them as new parents requires a user action.

## V2: exact-session discovery and queued prompts

### Tools and addressing

Discover live sessions from the PTY registry joined with validated task context. Exclude shells, unsupported targets, and sessions outside the caller's allowed scope. Do not reuse the coordinator child map or an agent-list endpoint that deduplicates by task. Return labels, branch, state, capabilities, `agentId`, and `sessionInstanceId`; unknown readiness is reported as unknown.

| Tool                    | Input                                                                        | Result                                                                 |
| ----------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `list_agent_sessions`   | Caller-scoped; no project override.                                          | Eligible sessions and their supported actions.                         |
| `get_agent_output`      | Exact agent and instance IDs; bounded size.                                  | Decoded plain-text output, observation time, and truncation indicator. |
| `send_agent_prompt`     | Exact target IDs, prompt, sender-scoped request ID.                          | Delivery ID and queued/submitted/closed receipt state.                 |
| `wait_for_agent_prompt` | Delivery ID, optional last observed state, and bounded timeout; sender only. | Current/changed receipt state, timeout, or expired/unavailable.        |

Require both recipient IDs and revalidate them at acceptance and delivery. A restarted pane is a different recipient even when `agentId` stays the same. Never redirect automatically. Decode scrollback, strip terminal control sequences, and enforce size limits. Validate membership, IDs, and payloads at the HTTP boundary; URL encoding is not authorization.

### Inbox and delivery

Use the staged-notification UI pattern with acknowledgment, extended to a list of queued incoming prompts per recipient instance. Store bounded queued entries in main-process runtime state so panel unmount/remount does not lose them; the renderer subscribes to snapshots/updates. Show sender/task attribution, preview, arrival time, and **Review** / **Dismiss**. Keep pending counts visible without stealing focus. Child summaries and the inbox start collapsed; expanded content scrolls within a bounded area so the task terminal remains usable. App restart may expire these entries; V2 does not promise a durable inbox.

**Review** opens a preview and leaves the entry waiting. After preview, an explicit **Use in composer** action claims the entry for manual handling and places it only in an empty app `PromptInput` belonging to the exact recipient session. If that field already has a draft, keep the incoming prompt in the inbox and offer preview/copy; never replace or concatenate the draft. Neither action sends Enter. Manual handling remains available while a message is waiting. It does not submit the prompt; automatic delivery claims are exclusive with manual handling.

Keep sender receipts to four states: `waiting` (queued until the recipient is ready), `delivered` (submitted to the exact terminal session), `handled` (the user took it into `PromptInput` or copied it), and `closed` (dismissed, failed, or expired, with a reason). Preview alone leaves it waiting. Handled means a human took responsibility; it never claims submission, agent acceptance, or task completion. Delivered, handled, and closed end the receipt wait loop; delivery does not mean the agent completed the request. No per-keystroke submission tracking is required.

Use sender-scoped in-memory request deduplication and existing prompt-byte/queue limits. Reject reuse with different target/content. A recipient exit expires queued entries; do not replay them on restart. Provide long-poll delivery receipts using existing wait conventions: after the initial state, callers supply their last observed state and wait for a change or timeout. Use a 30-second default wait and a 60-second maximum; agent-facing descriptions prohibit immediate polling/resending after a timeout and require another bounded wait. Receipt state describes transport only, not task completion.

### Automatic delivery and input arbitration

A global renderer loop offers queued messages for delivery independently of mounted task panels. It holds messages while the task has an unsent draft, terminal input, recent user activity, an initial assignment, staged child updates, a pause, or a write in progress. These task-wide holds conservatively cover every pane. Chat composer drafts use the same persisted draft field.

The backend validates the exact recipient launch, current relationship permissions, and orchestration setting. Delivery requires a parsed, stable ready prompt from the existing headless terminal mirror. Chat-only conversations have no peer session identity and are not redirected targets. Earlier queued messages and coordinator assignments take precedence.

The PTY writer binds its lock to the actual terminal session. Without bracketed-paste support, newlines and tabs become spaces so only the explicit Enter submits the prompt. Recent input delays acquisition; a per-session pending-input hold also protects unsent phone and secondary-pane drafts. During paste and delayed Enter, competing terminal, composer, phone, and coordinator writes queue behind that transaction with their inter-write timing preserved. Session identity and authorization are checked again before Enter. Restarted sessions never receive the old prompt or queued input. Failed delivery closes the receipt instead of retrying a possibly pasted body. A visible failure notice and recovery instructions remain in the recipient panel until the user dismisses them, including after the recipient session ends; dismissal does not change the sender receipt. Queued competing input is discarded on failed submission so an old Enter cannot submit the canceled body; the failure receipt explains this. Prompts identify the sending agent and task, and terminal control characters are rejected.

## Rollout and implementation sequence

Existing MCP startup arguments and tool selection describe a launch-time capability set. Do not rely on runtime tool-list refresh for this rollout. After orchestration is enabled, show **Restart and resume conversation to enable delegation tools** only when app-managed MCP configuration and the integration's resume path support it. Use the existing `restartAgent(agentId, true)` flow, preserving the pane/conversation while issuing a new launch identity and credential. Do not promise context preservation where resume is unsupported or fails; explain the limitation. Never restart automatically or silently fall back to a new conversation.

Explicit user-owned `--mcp-config` / related configuration currently prevents automatic injection in `canConfigureCanvasMcp()`. Preserve that configuration. A restart alone does not fix it: explain that the Parallel Code integration must be configured separately. Unsupported integrations show an accurate limitation rather than tools that always fail.

**V1 release:**

1. Extend the existing credential/spawn lifecycle with explicit capabilities and the separate lifecycle-owned authority map. Keep legacy roles and phone routing covered by negative authorization tests.
2. Add lazy parent registration and shared creation/admission with in-memory dedupe, the global orchestration setting, and parent pause gates. Implement the exact tool sets, bounded completion loop, independent UI review state, and child guidance matching the explicit review/automatic integration policy. Keep starting/failure UI state independent of successful child creation.
3. Move parent detach/close orchestration backend-side and implement restore. Expose task creation through MCP with accurate instructions, child counts/stop-all, review/result handling, and conversation-preserving rollout affordances. Ship only after lifecycle and UX checks pass.

**V2 release:**

4. Add relationship-scoped discovery/output and the optional top-level project peer-access setting. Verify exact panes, stale launch IDs, and permission enforcement.
5. Add the queued inbox, automatic delivery when ready, optional manual handling, bounded receipts/long polling, and cancellation/expiry.

No generic coordination service, persistent creation journal, automatic commit UI, or nested delegation is required for these releases.

## Verification and acceptance criteria

- **Identity:** same-instance attachment reuses the live credential; restart rotates it. Old tokens and delayed cleanup cannot affect the replacement. Missing lifecycle authority fails closed; partial/empty display broadcasts leave authority untouched. Validate actual Git membership, including legitimate external worktrees. Agent-supplied headers/body paths cannot choose another owner.
- **Compatibility:** existing canvas-only, coordinator/subtask, mobile/paired-device, Docker, and user-owned MCP configuration paths retain their policy. Legacy REST sentinel routing remains functional.
- **Ordinary delegation:** an app with no prior coordinator creates children from an eligible ordinary task. With default settings, fresh supported sessions expose `create_task` and create visible app tasks rather than native sub-agents. Child/grandchild and unsupported-task limitations are visible and enforced server-side.
- **Consent and stopping:** the global MCP switch alone enables task creation by default and disabling it denies new agent actions. Revocation and stop-all block pending/new launches; worktrees survive stopping and only user resume releases the pause. Automatic merging and automatic child updates are separate per-task opt-ins, both off by default; no coordinator preset remains.
- **Tools and feedback:** exact tool names match each profile and hidden handlers cannot bypass permissions. Ordinary completion waits work without a coordinator header, use bounded waits, and preserve the user's review queue when automatic child updates are off. Empty/no-work responses stop the loop; consumed events do not imply integration. Automatic child-update wait suppression, including the legacy fallback, is preserved.
- **Ownership and capacity:** concurrent parents in different projects and multiple panes in one task keep correct branches, limits, and child scope. Create/restart/restore cannot exceed capacity or race closing.
- **Snapshots and review:** dirty parents require an explicit committed-state choice; chosen commits are honored or refreshed on change. Review-required preambles direct completion to `signal_done` and do not instruct `land_self`; tool tests reject unapproved landing. Real-agent smoke checks should confirm normal completion does not waste a turn trying to self-land, without treating model obedience as a security guarantee.
- **Creation recovery:** duplicate requests return one result during the app run. Startup failures stay visible until dismissal/recovery. Simulated crash residue can be inspected/imported without automatic replay or deletion; no cross-crash exactly-once guarantee is claimed.
- **Close/restore:** a renderer crash during parent close cannot restore children targeting a deleted parent. Landing/close races, partial deletion, and retry preserve child work and integration policy. Detach covers authoritative children absent from runtime coordinator state and revokes relationship privileges across all panes. Hydration rejects unvalidated ownership and uses private credential files.
- **V2 access:** children can contact only their parent, unrelated top-level peers require opt-in, and cross-project requests fail. Test discovery/output as well as sends; disabling opt-in prevents further access and cancels unaccepted unrelated-peer entries.
- **V2 delivery:** distinct panes and restarted instances stay distinct. Queued prompts survive panel remount and wait beside an existing draft. Submission waits for a ready, draft-free exact terminal, including phone and secondary-pane input. Four-state receipts distinguish delivery from manual handling, closure, and waiting; none claims task completion. Cancellation must not submit a pasted body through a queued Enter.
- **UX:** MCP task creation without a delegation dialog, preserved terminal drafts/focus, visible startup/errors, review and integration, resume-preserving restarts with fresh credentials, and parent-close warnings work in Electron.

Run focused unit tests for startup/tool dispatch, HTTP authorization, coordinator lifecycle, and delivery. Pure logic tests use `npm run test:unit`; DOM tests use `*.client.test.tsx` through `npm run test:client`. Extend and run the opt-in PTY suite for changed delivery paths and perform native Electron smoke checks. Report unavailable Docker/native verification and skipped paid real-agent suites.

For implementation handoff, run `npm run check` and relevant tests, `npm run check:static` when exports/dependencies change, and the preload allowlist test when named IPC channels change. Check `docs/design-doc.md` with Prettier when updating this specification.
