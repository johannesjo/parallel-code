# Design — Add Agent Response Rendering

## Why a parallel reader, not a replacement

The obvious alternative is to **replace** the pty + xterm view with a
headless `claude -p --output-format stream-json` invocation, the way
Warp does it. Two reasons we don't:

1. **Interactive flows live in the TUI.** Permission prompts ("Allow
   edit?"), inline diff confirms, mid-stream `/clear` / `/compact`
   commands, and the agent's own UI for tool selection all require a
   real terminal. Headless `-p` mode drops them on the floor.
2. **Other agents have no equivalent.** Codex CLI, Cursor Agent, Aider,
   and arbitrary user-defined agents (`CustomAgentEditor.tsx`) all run
   as TUIs today. A redesign that pulled them out of xterm would touch
   every agent integration.

Tailing the structured session log that Claude Code (and others) already
write to disk gives us the same data Warp uses, with **zero change to
how the agent is invoked**. The panel is a second view onto the same
session.

## Data source: Claude Code session JSONL

Claude Code writes one JSONL file per session at
`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. Each line is one
event:

- `{ "type": "user", "message": {...}, ... }` — user turn
- `{ "type": "assistant", "message": { "content": [ ... ] }, ... }` —
  assistant turn; `content` is the standard Anthropic block array
  (`{type:"text",text}`, `{type:"tool_use",id,name,input}`,
  `{type:"thinking",thinking}`)
- `{ "type": "user", "message": { "content": [ { "type":
  "tool_result", "tool_use_id", "content" } ] } }` — tool result
- `{ "type": "summary", ... }`, `{ "type": "system", ... }` — ignored
  by the panel

We **fix the session id at spawn time** by injecting
`--session-id <uuid>` into the args we pass to `node-pty.spawn` for
Claude agents. The exact path is then known upfront; no glob,
no most-recently-modified guesswork.

## Adapter registry

```
interface AgentResponseSource {
  kind: 'jsonl-file';
  // template string with {sessionId}, {encodedCwd}, {home} placeholders
  pathTemplate: string;
  // adapter id → which parser turns raw JSONL lines into AgentResponseEvent
  adapter: 'claude-code-v1';
  // CLI argv injection: how to force a stable session id we can tail
  sessionIdArg?: { flag: string; valueFromUuid: true };
}
```

Built-in defaults registered in `electron/ipc/agent-response.ts`:

- `claude`: `pathTemplate:
  '{home}/.claude/projects/{encodedCwd}/{sessionId}.jsonl'`, `adapter:
  'claude-code-v1'`, `sessionIdArg: { flag: '--session-id',
  valueFromUuid: true }`.

The `claude-code-v1` adapter also covers **Sourcegraph Amp** out of the
box — Amp explicitly publishes a Claude-Code-compatible stream-json
format. We expose it as a separate default `amp` entry referencing the
same adapter id; differences are limited to where Amp writes its
session log (resolved at first run by reading `AMP_SESSION_DIR` env or
`$XDG_DATA_HOME/amp/sessions/`).

Custom agents in `CustomAgentEditor.tsx` may set the same fields; UI
hidden behind an "Advanced" disclosure for v1.

Future adapters with confirmed protocols (`codex-v1` for `codex exec
--json`'s `thread.*`/`turn.*`/`item.*` events; `cursor-agent-v1` for
its `stream_event` / `tool_call` shapes; `opencode-v1` for its
`Part`-array shape) plug in without changing the renderer. Gemini
`stream-json`, Copilot, Aider, Crush, and goose have no stable JSON
event stream as of 2026-05 and are deferred.

## Watcher lifecycle

One watcher per active task is started by the renderer when the user
opens the response panel for that task (or on app boot if the panel was
enabled at quit). The watcher is stopped when the panel is closed or
the task is removed.

```
StartAgentResponseWatcher { taskId, agentId, source, sessionId, cwd }
  → backend opens fs.watch on the file path (or polls fs.stat at 250 ms
    if fs.watch is unavailable on the platform); reads forward-only
    from the last-known byte offset; parses each new complete line via
    the named adapter; pushes one AgentResponseEvent per line via
    `webContents.send(AgentResponseEvent, payload)`.

StopAgentResponseWatcher { taskId } → close the watcher.
```

Crash semantics: the watcher process is the Electron main, same
lifetime as the renderer. If the JSONL file rolls (new session id),
the renderer issues a fresh Start with the new id; the backend reopens.

## Parser choice

Rather than hand-roll a JSONL parser for Claude Code, the backend
adapter uses **`@anthropic-ai/claude-agent-sdk`** (latest published as
of 2026-05). The SDK exports `SDKMessage` (a 25-member discriminated
union covering `SDKAssistantMessage`, `SDKUserMessage`,
`SDKResultMessage`, `SDKSystemMessage`, `SDKPartialAssistantMessage`,
`SDKToolProgressMessage`, `SDKPermissionDeniedMessage`,
`SDKCompactBoundaryMessage`, etc.) and helpers including
`getSessionMessages(sessionId)` for one-shot reads. For the tail we
still rely on `fs.watch` + line-buffer, but the *line → typed event*
step uses the SDK's exported types and dedup logic to avoid drift when
Claude Code ships protocol updates. Verbose-mode duplicate events
(observed in `--output-format stream-json --verbose` and equally
present in the session JSONL) are de-duped by `uuid`.

The lighter alternative is the community npm `claude-code-parser`
(zero-dep TS, dedup built-in). We prefer the official SDK because it
tracks new event types automatically; we will revisit if the SDK adds
runtime weight we cannot afford in the Electron bundle.

The opencode `Part` model (`packages/opencode/src/session/message-v2.ts`)
is the design influence for our normalised event shape below.

## Normalised event shape

```
type AgentResponseEvent =
  | { type: 'message'; role: 'user' | 'assistant'; id: string;
      blocks: ResponseBlock[]; ts: number }
  | { type: 'tool_use'; id: string; name: string; input: unknown; ts: number }
  | { type: 'tool_result'; toolUseId: string; ok: boolean;
      content: ResponseBlock[]; ts: number }
  | { type: 'thinking'; id: string; text: string; ts: number }
  | { type: 'session_start'; sessionId: string; ts: number }
  | { type: 'session_end'; sessionId: string; ts: number };

type ResponseBlock =
  | { kind: 'text'; text: string }
  | { kind: 'image'; src: string; mime: string };
```

Adapters convert their source format into this shape. Renderer code
only sees this shape, so adding a new agent does not touch the
component tree.

## Renderer surface

A new component `src/components/AgentResponsePanel.tsx`:

- Mounts under `TaskAITerminal.tsx` alongside `TerminalView`. Layout
  choice: a vertical split with the response panel on the right when
  enabled, controlled by a per-task signal `task.aiResponsePanelOpen`.
  Default closed.
- Subscribes to `AgentResponseEvent` via the existing `Channel<T>`
  primitive (`src/lib/ipc.ts:21-45`).
- Renders an ordered list of message bubbles. Each bubble:
  - **Assistant text block** → `createHighlightedMarkdown` (existing
    signal from `src/lib/marked-shiki.ts`).
  - **Tool use** → collapsible row showing `name` + truncated `input`;
    expanded view shows full JSON.
  - **Tool result** → collapsible row attached to its `tool_use_id`;
    body rendered as markdown if string, as JSON tree if structured.
  - **Image block** → `<img>` with safe `src` (see below).
  - **Thinking** → collapsed by default, italicised muted text when
    expanded.
- Toolbar: copy-thread, jump-to-latest, expand-all, collapse-all.

Wiring point: `src/components/TaskAITerminal.tsx` already hosts the
terminal toolbar; the panel toggle button goes there next to restart /
close.

## Markdown extensions

`src/lib/marked-shiki.ts` today calls `DOMPurify.sanitize(raw, {
ADD_ATTR: ['data-lang'] })` and does not allow `<img>`. We extend the
config behind a new exported `renderMarkdownForAgentResponse` so the
plan / notes viewers keep their stricter sanitiser:

- `ADD_ATTR: ['data-lang', 'src', 'alt', 'title']` for the agent-
  response renderer only.
- A custom DOMPurify `uponSanitizeAttribute` hook on `<img src>` that
  accepts:
  - `data:image/(png|jpeg|gif|webp);base64,...`
  - `https://...`
  - `file://...` where the path resolves under the task `cwd` (passed
    as a runtime parameter; computed via `path.resolve` + prefix check
    in the renderer process via preload-exposed `path.isInside(cwd,
    target)`)
- All other `src` schemes are stripped, leaving alt text visible.

Tables and mermaid already work (`PlanViewerDialog.tsx:104-122`
mermaid post-process is lifted into a shared helper).

## Streaming and perf

The JSONL writer flushes line-at-a-time, so we get one event per line
without partial-line risk if we buffer to `\n`. Each event triggers a
single Solid signal update appending one message to a `createStore`-
backed array. Shiki re-highlights only the new block, not the whole
thread, because each block has its own `createHighlightedMarkdown`
signal scoped to the block's text. This avoids the "re-highlight the
whole transcript on every token" pitfall called out in the
infrastructure audit.

The watcher pushes at most one event per JSONL line; no debouncing
needed.

## What we are explicitly not doing in v1

- No headless `--output-format stream-json` mode. Pty stays primary.
- No new input path. Users still type into xterm. A response-panel
  composer can come in a follow-up change once the read path is solid.
- No support for agents other than Claude Code at GA. The adapter
  registry makes adding Codex / Cursor / Amp a localised follow-up.
- No best-effort ANSI scraping fallback for Aider/Crush/Copilot. The
  panel simply says "Rich view not available for this agent."
- No persistence of normalised events to our own state file. The
  underlying JSONL is the source of truth; on reload we re-tail from
  byte 0.
- No agent-side write-back ("apply this diff button"). Tool-result
  blocks are read-only.

## References

- Claude Code CLI reference and stream-json schema (Anthropic docs).
- `@anthropic-ai/claude-agent-sdk` TypeScript types (`SDKMessage`
  union, `query()`, `getSessionMessages`).
- `claude-code-parser` (community npm; fallback parser option).
- `sst/opencode` `packages/opencode/src/session/message-v2.ts` — Zod
  schemas for the `Part`-array model that informed our normalised
  shape.
- `siteboon/claudecodeui` — web UI reference implementation consuming
  `--output-format stream-json --verbose`.
- Codex `exec --json` event reference
  (`developers.openai.com/codex/noninteractive`,
  `openai/codex/docs/exec.md`); deferred adapter.
- Cursor Agent `--output-format stream-json` reference
  (`docs.cursor.com/en/cli/reference/output-format`); deferred adapter.
- Amp owner's manual (`ampcode.com/manual`); same parser as Claude.
- Gemini CLI PR #8119 (stream-json mode, considered unstable);
  deferred.
