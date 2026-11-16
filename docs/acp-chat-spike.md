# ACP chat transport spike

Updated 2026-11-17. **Not now.** Don't add the [Agent Client Protocol](https://agentclientprotocol.com) (ACP) as a chat transport yet. Close the agent-choice gap by adding more terminal agents instead, such as Gemini, goose and Kimi ([#109]). Claude and Codex keep their native chat adapters. Revisit ACP when an agent we ship reports turn failures over it, or when users ask for chat with agents other than Claude and Codex.

Confidence is about 70%. The strongest evidence is that OpenCode reported none of the four provider failures it hit as an error, and that the scorecard measures how many agents we detect, not which ones get chat. The main uncertainty is that no model ever ran, so tool calls, permission requests, diffs and cancelling a live turn are untested, and that Copilot and Gemini over ACP may report errors far better than OpenCode.

## The question

Should the structured chat view, besides its native adapters, also speak ACP? Any agent with an ACP mode (OpenCode, Copilot CLI, Gemini CLI, goose, Kimi and others in the [registry](https://agentclientprotocol.com/get-started/registry)) would then get the chat UI instead of only a terminal. The question came from reviewing [codesk](https://github.com/latent-spaces/codesk), a small MIT app that drives every agent over ACP through the official TypeScript SDK with no per-agent code.

## What we have today

- **Chat is not Claude-only.** It has two providers, `'codex' | 'claude'` (`electron/chat/types.ts:35`):
  - Claude runs through the Agent SDK (`electron/chat/claude.ts`).
  - Codex runs through `codex app-server` over JSON-RPC (`electron/chat/sessions.ts:97-105`, `electron/ipc/codex-chat.ts`).
- **A third provider would get status, the phone UI and the context meter unchanged.** All of them read the shared `AgentChatState` (`electron/shared/agent-chat-types.ts:93-121`):
  - Task status short-circuits to `chatState` for chat agents (`src/store/taskStatus.ts:582-585, 1074-1078, 1146-1150, 1196-1200`).
  - The phone protocol sends the whole state (`electron/remote/protocol.ts:180-184`), and `src/remote/ChatDetail.tsx` reuses `ChatView`.
- **The two providers are hard-coded across the stack:**
  - the provider union in `ChatStartOptions`, `ChatSession` and `restoreChatSessions` (`agent-chat-types.ts:146-165`; the last two are persisted);
  - per-provider persisted task fields `claudeChatSessionId`, `codexChatThreadId` and `codexChatHandoff` (`src/store/types.ts:280-286`); a third provider needs its own;
  - session start, which resolves the executable and picks the adapter per provider (`electron/chat/sessions.ts:83, 88`);
  - start validation and Codex special-casing (`electron/ipc/register.ts:577-579`);
  - the agent-to-provider map (`src/store/agent-chat.ts:5-8`);
  - the name, session-id field, permission picker and `!` shell in `src/components/AgentChatView.tsx:39-41, 61, 277, 323-324`;
  - terminal↔chat handover (`src/store/agent-view.ts:47, 73, 117, 148-150`);
  - MCP tool label parsing (`src/components/chat/Transcript.tsx:155`).
- **The non-chat agents get no hooks either.** OpenCode, Copilot and Antigravity run only as terminals (`electron/ipc/agents.ts:19-70`). Hooks are injected only for Claude and Codex launches (`electron/ipc/pty.ts:796-810`), so these agents' status comes from output heuristics.

## ACP as of November 2026

- **Protocol:** version 1 is an integer that changes only on breaking changes ([initialization](https://agentclientprotocol.com/protocol/initialization)).
  - v1 schema releases are weekly and additive (1.30 to 1.32 in one week of November); a v2 draft is in alpha ([releases](https://github.com/agentclientprotocol/agent-client-protocol/releases)).
  - Zed and JetBrains govern it, Apache-2.0 ([governance](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/community/governance.mdx)).
  - `session/set_model` was removed on 1 June in favour of session config options ([RFD updates](https://agentclientprotocol.com/rfds/updates)).
- **SDK:** `@agentclientprotocol/sdk` 2.7.0, with peer dependencies on zod and `@modelcontextprotocol/server`. It went 1.0 in June and 2.0 in October, with weekly minors since. Codesk pins 1.4.0.
- **Agents:**
  - Copilot CLI's ACP server is a public preview ([changelog](https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/), [reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)).
  - Gemini uses `--acp` ([docs](https://geminicli.com/docs/cli/acp-mode/)).
  - The registry lists 46 agents. Its npx entries pin exact versions. sha256 is optional per binary ([schema](https://raw.githubusercontent.com/agentclientprotocol/registry/main/agent.schema.json)).
- **Claude and Codex adapters exist but don't help us:**
  - claude-agent-acp 0.107.3 and codex-acp 2.7.0 both advertise `loadSession`, `session/resume`/`list` and a system prompt on v1, and send `usage_update`. We checked this in their npm packages; claude-agent-acp's is in `dist/v1/acp-agent.js:525-571`.
  - claude-agent-acp wraps the same Agent SDK we use. It launches the Claude binary bundled next to it unless `CLAUDE_CODE_EXECUTABLE` is set.
  - codex-acp wraps `codex app-server` and launches the `@openai/codex` it bundles unless `CODEX_PATH` points at the user's own install (`dist/index.js:28182-28190`).
  - Moving either agent would add a layer and lose our direct use of `canUseTool` questions, `getContextUsage`, `setPermissionMode` and `runShell` (`claude.ts:219-232, 341-350, 393-410, 654-728`).

## How ACP would map onto chat state

| ACP                                          | `AgentChatState`                                         | Notes                                                                                               |
| -------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `agent_message_chunk`                        | `assistant` item                                         | Join chunks by `messageId`                                                                          |
| `agent_thought_chunk`                        | —                                                        | No thinking item exists; Claude streams only text deltas (`claude.ts:770-785`)                      |
| `user_message_chunk`                         | `user` item                                              | Sent when `session/load` replays history                                                            |
| `tool_call`, `tool_call_update`              | `tool` item with a `command`, `files` or `tool` activity | `execute` → command; edit, delete and move → files; `cancelled` → interrupted                       |
| tool content `diff {path, oldText, newText}` | `ChatDiff`                                               | `replacementDiff` and `wholeFileDiff` in `electron/shared/chat-diffs.ts`                            |
| `plan`                                       | `plan`                                                   | Direct                                                                                              |
| `session/request_permission`                 | `approval` request                                       | Answer with the agent's `optionId`; `reject_always` becomes decline                                 |
| form elicitation                             | `question` request                                       | Codex already maps MCP elicitations (`codex-chat.ts:585`)                                           |
| `usage_update {used, size, cost}`            | `contextUsage`                                           | No cost field; per-turn token usage is still a draft RFD                                            |
| `available_commands_update`                  | `commands`                                               | Direct                                                                                              |
| config options (model, thought level)        | `models`, `model`, `reasoningEffort`                     | OpenCode still sends legacy `models` and takes `session/set_model`; support both                    |
| modes                                        | —                                                        | Agent-defined; our permission modes are Claude's                                                    |
| `session/cancel`, `stopReason`               | `interrupt()`, `interrupted`, `error`                    | See the spike results: not every agent honours this                                                 |
| `session/load`                               | `threadId`                                               | Replays the transcript (only user prompts seen so far); start a new session when the agent lacks it |

## Spike (2026-11-17)

A throwaway client of about 75 lines, plus a 17-line MCP server, talked newline-delimited JSON-RPC to `opencode acp` (OpenCode 1.2.27), with no SDK. The scenario:

1. Read a file and call a tool on a tiny stdio MCP server passed in `session/new`.
2. Append a line to the file, which should trigger a permission request.
3. Start a long turn and send `session/cancel` after 6 seconds.
4. Kill the agent, start it again, `session/load` the session, and ask what was appended.

Each run started in a fresh git repository holding one `notes.txt`, and every JSON-RPC line was recorded. A free model and three providers from the user's own OpenCode setup were tried. Only the free-model and Copilot runs were kept; the missing-key and expired-token rows come from runs whose recordings were overwritten.

| Check                                        | Result                                                                                                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Handshake and capabilities                   | Works: protocol 1, `loadSession`, list, resume, fork                                                                                                       |
| MCP server passed in `session/new`           | Works: OpenCode started it and listed its tools                                                                                                            |
| `session/load` after a kill                  | Works: replayed every earlier prompt and the usage; no assistant output existed to replay                                                                  |
| Model switch with `session/set_model`        | Works, after a new session and after a load                                                                                                                |
| Slash commands, usage                        | Works: `available_commands_update`; `usage_update` with `used`, `size` and `cost` (shape only: values were 0)                                              |
| Exhausted free quota                         | **Hidden**: no update, no error, no stop reason; the prompt hung past our 180 s timeout. The cause is from OpenCode's log                                  |
| Missing Anthropic key                        | **Hidden**: reported as `end_turn` with no output, in under 100 ms                                                                                         |
| Expired OpenAI token (refresh failed, 401)   | **Hidden**: `end_turn` with no output                                                                                                                      |
| Copilot provider "Not Found"                 | **Hidden**: `end_turn` with no output                                                                                                                      |
| `session/cancel`                             | **Not exercised** on a live turn. With the hung prompt, cancel resolved the oldest pending prompt with `end_turn`, and the cancelled prompt never answered |
| Tool calls, permission requests, diffs, plan | **Not exercised**: no model ever ran                                                                                                                       |

The real errors appeared only in OpenCode's log file. A chat view built on this would show "done" for a failed turn, which is worse than the terminal, where the error is visible. Copilot couldn't be tested: `/usr/bin/copilot` on the test machine is VS Code's shim, not the Copilot CLI.

## Options compared

- **More terminal agents (recommended).** A small entry each in `electron/ipc/agents.ts` (about 8 lines, plus resume args where the CLI has them). This answers what the scorecard actually measures: Emdash detects 37 agent CLIs and Orchestrator 36, against our 5 plus custom agents (`docs/market/scorecard.md`). [Market README](market/README.md): a gap is a prompt to look, and the core loop stays simple.
- **ACP for agents without chat, behind a setting.** One adapter, estimated at about 600 lines by analogy with `CodexChat` (687 lines), plus tests. It's the right shape when we do want chat for more agents. Not worth it while the first candidate hides failures.
- **A native adapter per agent.** OpenCode's HTTP server, Copilot's SDK and so on. Worse than one ACP adapter once it covers more than one agent.
- **Claude or Codex over ACP.** No: it adds a layer over what we already use, loses features, and launches a CLI the adapter chooses, possibly not the user's own install.

## If we revisit

- **Pick the first agent by error reporting.** Run the spike scenario against Copilot's own `copilot --acp` and Gemini's `--acp` first. Then run one turn per failure kind, starting with a missing login and a bad model.
- **Slice:**
  - an `AcpChat` in `electron/chat/acp.ts`, with pure mappers in `acp-map.ts`;
  - the `acp` provider in `types.ts`, `agent-chat-types.ts` (persisted, additive only), `sessions.ts` and `register.ts`;
  - a per-agent ACP args field in `electron/ipc/shared-types.ts` and `agents.ts`;
  - an `acpChatSessionId` task field, the provider map, the name and session key in `AgentChatView.tsx`, and a setting in `src/components/settings/AgentSettings.tsx`;
  - MCP config translated to ACP `mcpServers` in `electron/mcp/canvas-config.ts`.
- **What slice 1 leaves out:**
  - Terminal↔chat handover: chat and terminal stay separate conversations.
  - Registry installs: the user's installed CLI only, detected as today, run without a shell.
  - Docker and coordinator tasks, which are already excluded from chat.
- **Adapter rules the spike showed are needed:**
  - Treat `end_turn` with no output as an error.
  - Mark a turn as failed after N seconds without updates.
  - Show the agent's stderr when a turn fails.
  - If cancel isn't answered within about 10 seconds, kill the process and `session/load`, as codesk does (`src/acp.mjs:608-625` in its repository).
  - Show a sign-in state for `authRequired` (-32000) and keep the message queued, as codesk does (`src/acp.mjs:555-558`).
- **Tests:**
  - mapper unit tests on recorded sessions;
  - a scripted fake agent over stdio for start, prompt, permission, cancel, crash and sign-in;
  - an opt-in real-agent test like `electron/chat/claude.integration.test.ts`.
- **Supply chain, if registry installs come later:** user-initiated only, exact versions, sha256 required for binaries, no unpinned npx. Codesk extracts tar archives without path filtering and runs `npm install` with install scripts (`src/agents.mjs:256, 283`). Our custom agents live in app settings, not repository files, so a cloned repository can't define agents. Keep it that way.

## Not verified

- Tool-call, permission, diff and plan updates from any agent, and assistant output or tool calls replayed by `session/load`.
- Cancelling a live turn.
- Copilot CLI, Gemini and goose over ACP, including whether Copilot's ACP server is GA.
- Windows: npm `.cmd` shims fail with a plain `spawn`. Chat resolves the executable with `which` only for Claude (`electron/chat/sessions.ts:32-48, 83`); Codex spawns the command directly, so an ACP adapter needs its own resolution.
- Agent detection with `which` (`electron/ipc/agents.ts:73-78`) probably treats VS Code's `copilot` shim as an installed Copilot CLI. Not checked in the app.

[#109]: https://github.com/johannesjo/parallel-code/issues/109
