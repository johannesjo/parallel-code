# Recorded agent sessions

Each file is one agent session: what the agent printed, what was typed, its raw hook payloads, and the pauses between them. `src/store/recorded-session-replay.test.ts` plays every file through the same path the app uses (hook mapping, main-process reducer, renderer status and screen heuristics) and checks each `expect` step against the task's attention state (`active`, `needs_input` or `idle`). A session without hooks (`"hooks": "none"`) also replays the OSC 7501 program status it printed, as the main process reads it from such launches. A new file here is tested without further code. The `claude-2.1.328-*` files are full recordings (screen, keys and hooks), `codex-0.167.2-*` screen and keys without hooks; the older ones carry hook payloads only. Not replayed yet: the Codex turn watch that reads failures from the screen, and clicks on on-screen options. Only Claude Code and Codex have recordings; Gemini and Copilot are covered by the frame fixtures in `taskStatus.test.ts`.

Name files `<command>-<version>-<scenario>.json`. Record again when an agent CLI updates, so a change to its screen or hooks fails here instead of in users' hands.

## Recording a session

`scripts/showcase/scenes/record-status.spec.ts` records the approval, interrupt and question scenarios in the headless app, on Haiku for Claude Code and the cheapest model for Codex, billed to your plans (build the app first, see `scripts/showcase/README.md`). Codex runs need a ChatGPT login renewed in the last six days, and record no hooks: the showcase refuses `codex app-server`, which the hook probe needs.

```sh
SHOWCASE_REAL_AGENTS=1 PARALLEL_CODE_RECORD_SESSIONS=$HOME/pc-recordings npx playwright test --config scripts/showcase/playwright.config.ts record-status
```

By hand:

1. Start the app with an absolute directory in `PARALLEL_CODE_RECORD_SESSIONS`, for example `PARALLEL_CODE_RECORD_SESSIONS=$HOME/pc-recordings npm run dev`.
2. Run the scenario in an agent task: a plain turn, an approval, a question, an interrupt, a background sub-agent. Every agent launch writes one file when it exits.
3. Trim the file to the scenario and set `version` (from `claude --version` or `codex --version`) and `summary`.
4. Replace ids, paths, user names and anything private. Recordings contain everything typed and shown.
5. Add `{ "expect": "…" }` steps for what the task should have shown at that point, judged from what happened on screen, not from what the app showed.

`hooks` names the hook format (`claude`, `codex` or `none`); the recorder fills it in.

Step kinds: `{ "hook": … }`, `{ "output": "…" }`, `{ "input": "…" }`, `{ "wait": ms }`, `{ "expect": "active" | "needs_input" | "idle" }`.
