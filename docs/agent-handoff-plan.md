# Agent handoff implementation plan

Status: Implemented with automated verification. Updated 2026-10-13: the composer was reduced to one editable message (see **Composer and context**); presets, context toggles and captured diffs were removed.

A compact toolbar **Second opinion** button opens a chooser that can reuse an existing session or start a fresh reviewer without first adding a terminal manually. Dismissal is saved per task; the action remains available in the terminal's right-click menu and via Ctrl+Shift+O (Cmd+Shift+O on macOS). The shortcut is remappable in keyboard settings and opens the chooser without submitting it. Selecting terminal text exposes a small nearby actions button and a right-click menu with **Copy** and named **Send to** recipients. New Claude and Codex reviewers offer a model menu in the composer, sharing the Generate Tour model choices, component, and selected preference; existing sessions keep their model. The same menu sets a reasoning level, remembered per provider; Codex offers only the levels its model cache lists for the chosen model, and none without that cache. Forwarding opens an inline composer; the task-wide second-opinion action uses a dialog.

Fresh reviews reuse the normal add-agent flow and open a normal terminal behind the chooser. Starting and submitting is explicit, targets the exact launched session, and preserves the draft after startup failure; there is no hidden background-agent runtime. Existing queue safeguards and receipt semantics are unchanged. The task prompt in the message comes from `savedInitialPrompt`.

Subagent review corrections: project peer-policy updates preserve user-origin handoffs, and session refresh/reselection keeps edited drafts intact.

Verification: focused handoff, terminal-menu, reviewer-startup, and dismissal-persistence tests passed, as did the affected suites, `npm run check`, and `npm run check:static`. The affected unit suite skipped 12 opt-in tests. Native Electron and paid real-agent smoke tests have not been run. The sections below record the implementation contract and deferred work.

Make it easy for two agents in the same task to critique and refine each other's work. Add one user-controlled **Ask the other agent** composer for code reviews, plan critiques, and custom messages. Reuse the interaction for the return trip; automatic conversations are outside this release.

## Product decisions

- Scope the first release to desktop terminals in the same task. The user may explicitly start a fresh reviewer from the chooser. Reuse the task worktree and normal agent lifecycle.
- Show a small, dismissible **Second opinion** button in the terminal toolbar, outside the output area. Keep the action in the terminal context menu after dismissal; save dismissal per task.
- Selected text gets **Copy** and **Send to named agent…** actions, with **Ask another agent…** when none exists. Capture selected text when opening the menu so focus changes cannot alter it.
- The task-wide chooser names existing sessions and fresh reviewer options. Existing sessions are preferred when available; otherwise suggest a different installed supported agent. Launch only after the user submits.
- The selection flow stays inline; the task-wide flow uses a compact dialog. Both show one editable message that is sent exactly as shown, with no presets or hidden context.
- Use one **Send** action. Delivery waits for safe input readiness when necessary. Never offer a force-send action that bypasses draft, typing, or question protection.
- The user decides when to request review and when to send findings back. Input readiness is not proof that implementation or review has finished.

Example: Claude implements a change. The user asks Codex to review it, reads Codex's response, selects the useful findings, and sends them back to Claude with an instruction to verify and fix valid issues. A recheck uses the same composer again.

## Composer and context

The composer shows the reviewer choices, a model and reasoning menu for a new Claude or Codex reviewer (an open session keeps its current model and level), and one editable message. What the box shows is what gets pasted into the recipient's prompt; there are no presets, toggles or attachments. Keep the text after preparation or delivery failure. Do not replace an existing recipient draft.

- **Task-wide second opinion:** the message asks the reviewer to review the changes on this branch since it split from the task's base branch, including uncommitted and new files, and names the `git diff`/`git status` commands. It adds the task prompt when one is available. Without Git isolation it says "Review the work in this folder." The reviewer shares the worktree, so the diff is referenced rather than captured; it reads the live files.
- **Selected output:** the message quotes the selected text and names the agent it came from.

Typing is cleaned as it happens: controls that could end the bracketed paste early and invisible formatting characters are removed, and peer message markers get a visible dot so the queue accepts them. Messages over the queue's 64 KB limit are refused with an explanation instead of being truncated. A review instruction asking the recipient not to edit is advisory, not enforced read-only access.

## Delivery contract

Reuse established readiness and prompt-writing safeguards, with an explicitly user-initiated message origin. Existing peer envelopes say that a message is not from the user; they cannot be reused unchanged for this action.

- Bind each accepted request to its task, recipient agent, and exact running session. Closing or restarting that session must not redirect the request to a replacement.
- Validate recipient membership, availability, content limits, and relevant orchestration gates in the main process. The UI is not the authorization boundary.
- Preserve recipient drafts, in-progress typing, trust prompts, and questions. Queue until delivery is safe; expose why a request is waiting where existing state supports it.
- Disable duplicate submissions and use the existing receipt/idempotency conventions where applicable.
- Show **Queued for Codex**, **Delivered to Codex**, **Canceled**, or a delivery error. Delivered means prompt submission, not task completion or successful review.
- Provide **View message** and cancellation while still queued. Once submission starts, do not claim cancellation succeeded unless the delivery layer confirms it.
- If a write may have partially succeeded, retain the error and ask the user to inspect the terminal before manually resending. Never retry automatically after an ambiguous submission.
- Reuse current queue lifetime and restart behavior. Do not add persistence merely for this feature; document actual behavior in the implementation and avoid implying durable delivery.

## Existing integration points

| Area                              | Existing code                                                      | Planned use                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Agent selection and header        | `src/components/TaskAITerminal.tsx`                                | Entry point and same-task recipient selection                                                                                       |
| Terminal selection                | `src/components/TerminalView.tsx`                                  | Capture selected text and expose a narrowly scoped callback                                                                         |
| Drafts and safe prompt submission | `src/components/PromptInput.tsx`, `src/store/tasks.ts`             | Reuse prompt preparation and draft protection without inventing another readiness loop                                              |
| Peer delivery                     | `electron/mcp/delegation.ts`                                       | Evaluate extending the existing queue with a user origin and renderer-accessible submission                                         |
| Queue and failure display         | `src/components/DelegationPanel.tsx`                               | Reuse message visibility, cancellation, and failure patterns                                                                        |
| Existing review findings          | `src/components/ReviewProvider.tsx`, `src/lib/quality-findings.ts` | Leave existing submission and freshness behavior intact; freeform terminal output does not automatically become structured findings |

The peer tools already support session discovery, bounded output reads, queued prompts, and receipts (`electron/mcp/mcp-tool-list.ts`). This feature makes user-directed exchanges discoverable; it does not introduce a new agent protocol.

## Implementation sequence

### 1 Verify delivery integration

Trace renderer delegation requests, main-process authorization, session identity, queue cancellation, and human-input guards. Confirm whether the current queue can support a discriminated user origin without fabricating an agent sender or changing existing peer behavior. Confirm the source and limits of task prompt and diff attachments.

Prefer a small extension to the existing queue over a parallel scheduler. Do not model a new handoff as an initial task prompt or coordinator notification. If safe queuing requires a separate delivery subsystem, reconsider a smaller explicit **Open in recipient composer** release before implementing that architecture; that alternative changes the one-click-send behavior and should be surfaced to the user.

### 2 Implement the composer and toolbar entry

Add the recipient picker, presets, explicit context controls, final preview, and local draft/error state inline beneath the agent tabs, with context and preview collapsed. Prepare bounded prompts through a small pure helper only where it reduces duplication and makes the message contract testable. Keep transient composer state local to the owning task; clean it up on disposal.

### 3 Connect safe delivery and receipts

Implement the smallest main-process operation needed for user-origin requests, validate exact recipient identity, and connect the existing queue/status surface. Preserve peer-origin wording and behavior for actual agent messages. If a named IPC channel is added, update the manifest, preload allowlist, registration, and frontend helper together.

### 4 Add selection and return flow

Wire terminal selection into the same composer. Preserve quoted text and source identity without ANSI/control sequences becoming terminal input. A reviewer-to-implementer return uses Custom with editable instructions; do not add a second workflow or parse terminal findings into checkboxes.

### 5 Validate and trim scope

Review the final diff for duplicate readiness logic, unnecessary persistent state, and speculative abstractions. The complete implementation will likely cross more than three production files because it joins terminal selection, composer UI, and main-process delivery. Keep those changes limited to the contract above and split work into reviewable increments.

## Acceptance and verification

- With one live agent, Second opinion can start a fresh reviewer. With existing peers, the chooser and selection menu target them explicitly; closed, shell-only, and unsupported sessions are excluded.
- Both entry points preserve edited drafts and show the exact outgoing context. Missing task text and oversized diffs produce understandable UI states.
- A user can critique a plan without a diff and review changes without forwarding the implementer's explanation.
- A busy recipient, existing draft, terminal typing, or question prevents unsafe submission. Closing or restarting the recipient while queued prevents delivery to the wrong session.
- Rapid double-clicks do not submit twice. Cancellation and partial-write failures report truthful outcomes and do not trigger automatic retries.
- Human-origin handoffs and agent-origin peer messages have correct, distinct attribution.
- A full manual exchange works in both directions using the same UI. Opening or dismissing the composer never launches an agent. Only explicit submission of a fresh-review choice starts a new terminal.

Add focused unit coverage for message construction, validation, session binding, cancellation, and duplicate/ambiguous submission behavior. Add component coverage for recipient selection, context controls, draft preservation, and receipt states. Extend existing tests where those responsibilities already live.

Run relevant unit and client suites plus `npm run check`. Run `npm run check:static` if exports or module dependencies change, and the preload-allowlist test if named channels change. Before committing, run `npm run test:changed` as required by repository guidance.

Manually smoke-test in Electron with two existing agent terminals: selection capture, keyboard/focus behavior, a normal round trip, a recipient with a draft, a queued cancellation, and a recipient restart. Report any unavailable native or real-agent verification; automated tests should use fakes and must not launch paid agents.

## Deferred features

Automatic rounds, role assignment, completion/convergence detection, dedicated rebuttal/recheck controls, terminal-answer extraction, structured agent findings ingestion, enforced read-only sessions, immutable worktree snapshots, cross-task handoffs, phone/chat UI integration, and new durable message history.

Revisit structured findings only after the manual exchange proves useful. Reuse the existing findings model at that point rather than adding a second review system.
