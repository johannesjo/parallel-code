# Plan, approve, implement: design proposal

Status: First step of option (a) implemented 2026-11-19: **Implement in fresh session** and **Back to planning session** in the plan viewer, for Claude Code and Codex terminal panes, and only when the planning session can be reopened. The approved-plan snapshot, option (b) and option (c) are not built yet.

## Why

Long planning conversations fill an agent's context window, and implementation quality drops once the agent starts compacting or forgetting. Codex CLI 0.169 (as reported in its release notes) answers this with **"Yes, clear context and implement"**: on approval the plan goes to a fresh session, and the old session is kept if the handoff fails. Claude Code has plan mode and its own compaction. VS Code lets another agent review a plan, and Devin shows a fuller plan view before approval.

Parallel Code runs many different agent CLIs, so it can offer this for all of them, and it can do what a single-vendor CLI can't: plan with one agent and implement or review with another.

## How it works today

**Short version:** Parallel Code shows plans, but it does not take part in approving them.

- **Spotting a plan.** The app watches the worktree for plan Markdown files (`.claude/plans/`, `docs/plans/`, or a root file with "plan" in its name) and treats the most recently changed one as "the plan". This works the same for every agent, but only if the agent writes such a file. Claude Code does this reliably because the app points its plan folder into the worktree. Codex, OpenCode, Copilot, Antigravity and custom agents only show up if they happen to write a matching file.
- **Knowing a plan is waiting.** For Claude Code in a terminal, a hook notices the plan approval dialog and sets the task to "Plan ready for approval". That only drives the status and notifications. No other agent reports this, and Codex's own plan mode is not detected at all.
- **Reviewing.** **Review Plan** opens a viewer with the rendered plan, inline comments, **Take Tour** and **Open in editor**. Comments are sent back to the agent as an ordinary prompt ("Feedback on the implementation plan: …"). There is **no Approve or Reject button**. Approving means clicking into the terminal and answering the agent's own dialog.
- **Claude chat mode** is the only place with a plan-mode switch ("Plan only"). There, approval is a generic Allow/Decline card, and Decline sends a fixed message with no room for feedback.
- **Starting fresh.** A terminal agent can only be restarted fresh after it has exited. Chat mode has **New chat**, but it starts empty. Nothing starts a fresh session and hands it a plan.
- **Second opinion already exists.** A user can start a fresh reviewer of any installed agent type in the same task, or forward selected output to it, through one editable message. That covers cross-agent review in general. It is not offered from the plan viewer, and it requires the source agent to have collaboration tools turned on.

### Where it breaks down

| Problem                                  | Effect for the user                                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Context bloat                            | After a long planning back-and-forth, implementation happens in the same overloaded session. Nothing helps the user start clean.          |
| Plan not tied to a session or approval   | "The plan" is simply the newest file. An older or inherited plan can show up, and nothing records which plan was approved.                |
| Plan lost on restart                     | Only the file name is saved. If the agent rewrites or deletes the file, for example in the next plan round, the approved version is gone. |
| No cross-agent plan review from the plan | Second opinion works, but the user has to open it separately and write the request.                                                       |
| Uneven agent support                     | Only Claude Code (terminal) is reliably detected. Other agents need to write a plan file by convention.                                   |

## Design options

All three share one building block: an **approved plan snapshot**. On approval the app stores the plan text, its source file, the time, the agent and session that wrote it, and the commit the worktree was on. It is saved with the task, so it survives restarts and later plan rounds, and the plan viewer can show it as "Approved plan".

### (a) Approve and implement in a fresh session (same agent)

**What the user sees.** The plan viewer gets an **Implement in fresh session** button. Clicking it restarts the task's agent with an empty context, and its first message is the approved plan: "Implement this approved plan. The source file is …", with the plan text included. The planning conversation stays in the session history. If the new session fails to start or never accepts the plan, a notice offers **Back to planning session**, which reopens the old conversation unchanged, and the plan message is kept for a retry.

**Why restart the same pane rather than add a second one.** Restarting ends the planning process, which may still be sitting at its own "approve plan?" dialog. That guarantees only one agent is writing in the worktree. A second pane would leave two agents able to edit the same files.

**Which agents.**

- **Claude Code and Codex (terminal):** full support. The app can reopen the exact old session, provided it knows the session's id. It always does for Claude; for Codex this still needs checking.
- **OpenCode, Copilot, Antigravity, custom agents:** the restart and handoff work the same way, because the plan is delivered as an ordinary first prompt. These CLIs can't reliably reopen one specific old session, so for them the app should start the implementer in a **new pane** and leave the planning pane open but idle until the user closes it. The confirm text says so.
- **Agents without plan mode or a plan file:** the button is available wherever a plan was detected. A later step can add a "plan first" instruction for any agent (see below).
- **Claude chat mode:** same idea through **New chat** plus a first message. A separate, small follow-up.

**Failure handling.** Save the snapshot and the old session id **before** restarting. Restore the old session if the new process exits before the plan is delivered, or if delivery gives up after its usual wait. Never resend automatically after an unclear delivery; reuse the existing duplicate-protection behaviour of the first prompt.

**Effort.** Small to medium: about 2–3 days, mostly reusing the existing fresh restart, session ids and first-prompt delivery.

### (b) Hand the plan to a different agent

**What the user sees.** The same button has a menu: **Implement with Claude / Codex / OpenCode / …**. The app switches the pane to the chosen agent (that action already exists and always starts fresh) and sends the plan as its first message. A second entry, **Ask another agent to review**, opens the existing Second opinion dialog pre-filled with a plan-critique request that names the plan file. Its findings come back through the same dialog the user already knows.

**Which agents.** Any agent can be the implementer, because the handoff is plain text. Review works with any agent Second opinion supports today. Removing Second opinion's requirement that the source agent have collaboration tools is worth considering, since the plan viewer is not an agent.

**Failure handling.** Same as (a). Returning to planning switches the pane back to the original agent and reopens its session.

**Effort.** Small once (a) exists, about 1 day. The review entry alone is about half a day and doesn't depend on (a).

### (c) Plan checkpoint

**What the user sees.** Each approved plan becomes a checkpoint in the plan viewer: "Approved 14:02 · Claude · commit abc123". From it the user can **reopen the planning session** to rethink, **restart implementation** from the same plan, or, as a separate and clearly confirmed action, **discard the implementation**, resetting the worktree to the commit at approval.

**Which agents.** Reopening and re-implementing work wherever (a) works. Discarding is agent-independent because it is a Git operation.

**Failure handling.** Discarding destroys work, so it must show what will be lost, refuse when there are commits that were already pushed, and probably save a backup branch first.

**Effort.** Reopen and restart: about 1 day on top of (a), since the snapshot already holds what they need. Discard: about 2–3 days plus careful testing. It should be designed separately.

### Option considered and rejected for now: driving each CLI's own approval dialog

The app could send keystrokes to answer each agent's plan dialog. Codex 0.169's native "clear context and implement" could then be used directly. This depends on each CLI's screen layout and changes with every release, and it gives no cross-agent handoff. When a CLI has its own handoff, users can keep using it in the terminal. Parallel Code's job is the part that works the same for every agent.

## Recommendation

Build **(a) with the approved-plan snapshot first**, then the **(b) menu**, and treat **(c)** as a follow-up driven by demand.

Recommended flow:

1. The agent plans: Claude plan mode, Codex plan mode, or any agent asked to write a plan file.
2. The task shows "Plan ready", either from the hook or because a new plan file appeared. The user opens **Review Plan**.
3. Optionally: **Ask another agent to review**, using the existing Second opinion dialog, pre-filled.
4. The user clicks **Implement in fresh session**, or picks another agent from its menu. The plan is saved as approved, and the pane restarts clean with the plan as its first message.
5. If anything goes wrong, **Back to planning session** reopens the old conversation.

### Smallest first step

**"Ask another agent to review" from the plan viewer.** It opens the existing Second opinion dialog with a message pointing at the plan file. Nothing restarts and no new delivery path is needed, so it's about half a day of work with almost no risk. It does not fix context bloat on its own.

The **smallest step that fixes context bloat** is (a) for Claude Code and Codex terminal panes only: snapshot, restart fresh, plan as the first prompt, and Back to planning session on failure. Estimate 2–3 days. One thing must be confirmed while building: that the first-prompt auto-send fires again after a fresh restart of an existing pane. The code suggests it does, but this hasn't been tested.

Neither is a trivial change, so nothing has been built.

### Known limits of the first step

- **Back** reopens the session the pane was started in (Claude) or the newest one in the worktree's history (Codex). If the user ran `/clear` or `/resume` inside the CLI during planning, that may be an older conversation. The real planning conversation is still in the session history.
- Not offered for chat mode or for tasks run by a coordinating agent, whose prompts the coordinator delivers.
- For Codex, the planning session is found in the worktree's session history. The handoff is refused when that is ambiguous: two Codex panes in the task, or a task working in the shared project folder. A Codex sub-agent session that is newer than the planner could still be taken for it.
- If the app closes before the plan is delivered, the queued plan is dropped unless the pane will reopen its fresh session. Click **Implement in fresh session** again.
- Nothing asks for confirmation when the planning agent is mid-turn. The partial turn stays in its transcript.
- Going back before the plan has been sent leaves the plan text in the prompt box. It is not sent unless the user sends it.
- Handing over again from the implementing session keeps **Back** pointing at the original planning session.

### Later, for agents without a plan mode

- A **Plan first** option when creating a task. For Claude Code it starts in plan mode. For every other agent it adds an instruction to write the plan to a known file and stop before editing. That instruction is advisory, not enforced. It makes plan detection reliable for every agent and complements issue #256, which asks for a plan-mode control in the prompt box.
- Detecting Codex's own plan proposal, so the task shows "Plan ready" for Codex as it does for Claude.

## Open questions

1. Should the fresh session get the plan text inline, or only a pointer to the file? Recommendation: inline, plus the file path. Inline makes the handoff self-contained even if the file later changes. The path lets the agent re-read the plan after its own compaction.
2. For agents that can't reopen a specific session, is a second idle pane acceptable, or should the app close the planning pane after a successful handoff?
3. Should the approved plan also be written into the worktree (for example under `.claude/plans/approved/`) so the agent and the user can see it in Git tools? That risks agents committing it into user repos.

## File references

Current behaviour (verified against this branch):

- Plan watcher: `electron/ipc/plans.ts:21` (watched folders), `:34-58` (Claude plan folder set in the worktree's `.claude/settings.local.json`), `:126-145` (newest file wins), `:147-182` (recovered plans on spawn), `:281-340` (watcher), `:355-373` (re-read after restart).
- Watcher start and stop: `electron/ipc/register.ts:666`, `:798`, `:957`, `:1466`.
- Claude plan-approval hook: `electron/agent-hooks/status.ts:120-123`, `:197-213`; the status shows in `src/store/agentHookStatus.ts:261`, `:349`.
- Codex plan mode is seen only as a generic question: `electron/agent-hooks/codex-recordings.ts:305-334`.
- Plan viewer and feedback: `src/components/PlanViewerDialog.tsx:39-50` (feedback text), `:335-361` (buttons: Take Tour, Open in editor, Close); `src/components/ReviewProvider.tsx:450-488` (sent to `agentIds[0]`); `src/components/TaskNotesBody.tsx:173-214` (Review Plan entry).
- Plan state: `src/store/tasks.ts:1910-1919`; only `planFileName` is persisted (`src/store/persistence.ts:472`, restored at `:1368`, `:1523`).
- To-do plan (Plan card): `src/store/task-plan.ts`, `src/lib/app-facts.ts:78-86`. The Task context pane from 69177525 was replaced by the Plan card (`docs/cards.md`).
- Claude chat plan mode: `electron/shared/agent-chat-types.ts:70`, `electron/chat/claude.ts:162-193`, `:341-350`; Decline text `:490-495`.
- Agent definitions have no plan capability: `electron/ipc/agents.ts:19-71`, `electron/ipc/shared-types.ts:9-26`.

Building blocks for this design:

- Fresh restart with a new session id: `restartAgent` in `src/store/agents.ts:171-198`; switching agent type with a fresh session: `switchAgent` in `src/store/agents.ts:222-247`; resume with extra flags: `resumeAgentWithFlags` in `src/store/agents.ts:207-220`.
- Session ids and resume args: `electron/shared/session-resume.ts:40-75`, `src/store/session-ids.ts:19`, `src/lib/agent-args.ts`; reopening a past session: `resumeAgentSession` in `src/store/sessions.ts:55-71`.
- First-prompt delivery with readiness and echo checks: `src/components/PromptInput.tsx:205-470`, `:862-918`; gate `src/components/prompt-control.ts:30-39`.
- Second opinion: `src/components/AgentHandoffComposer.tsx` (fresh reviewer at `:311-327`, collaboration-tools requirement at `:436-450`), message text `src/lib/agent-handoff.ts`, contract in `docs/agent-handoff-plan.md`.
- Restart menu only on exited panes: `src/components/TaskAITerminal.tsx:833-893`, `:1053-1180`.
- MCP handoff tools (`create_task`, `send_prompt`, peer prompts): `electron/mcp/mcp-tool-list.ts`, `electron/mcp/delegation.ts`. MCP children always inherit the parent's agent type (`delegation.ts:495-497`).
- Plan-mode control request: GitHub issue #256.
