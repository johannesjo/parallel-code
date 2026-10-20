# Showcase video editor

`edit.mjs` turns screen recordings into a silent 1920 × 1080, 30 fps showcase MP4 with dissolves, eased zooms and fading captions. It also writes a `.jpg` poster beside the video. The whole edit is described in one JSON timeline, so a new cut means editing data, not code.

Requirements: Node.js and `ffmpeg` on `PATH`. Captions use Noto Sans by default (`fonts-noto-core` on Debian/Ubuntu); set `fonts` in the timeline to use other TTF files.

```sh
cp scripts/showcase/example-timeline.json ~/showcase-footage/timeline.json
# edit the clip list and captions, then:
node scripts/showcase/edit.mjs ~/showcase-footage/timeline.json
```

Keep footage, renders and output outside the repository. Relative paths in the timeline resolve from the timeline file. Rendered clips are cached in `work` and reused while a clip's settings and source file are unchanged. Caption and transition edits therefore rerun only the final encode (about 1–2 minutes for a 50-second video); changing a clip's `start`, `duration` or `camera` rerenders that clip. After changing the render code itself, delete `work`, because the cache does not track the script.

## Timeline format

`example-timeline.json` is the edit of the 47-second v10 showcase.

| Field      | Meaning                                                              |
| ---------- | -------------------------------------------------------------------- |
| `footage`  | Folder with the raw recordings. Default: the timeline's folder.      |
| `work`     | Cache for rendered clips and filter files. Default: `work`.          |
| `output`   | Final MP4. The poster uses the same name with `.jpg`.                |
| `posterAt` | Poster frame time in seconds. Default: `1`.                          |
| `fonts`    | Optional `{ "regular": "...ttf", "bold": "...ttf" }`.                |
| `clips`    | Shots in order. Each needs `file`, `start` and `duration` (seconds). |
| `cues`     | Captions: `title`, optional `sub`, and `at`/`until` anchors.         |

Clips play at their recorded speed and dissolve into each other over 0.4 s. Set `"transitionAfter"` to change the dissolve after a clip; `0` makes a hard join, which suits two adjoining pieces of the same recording. Each clip must be longer than its incoming and outgoing dissolves combined.

Recordings must be 16:9; they are scaled to 1920 × 1080. Recording above 1080p, for example 2400 × 1350, keeps zooms up to 1.25× sharp.

### Camera

A clip's optional `camera` eases in and out of zooms at chosen moments:

```json
{
  "focusX": 0.89,
  "focusY": 0.28,
  "moves": [
    { "at": 1.3, "seconds": 0.8, "zoom": 1.35 },
    { "at": 3.8, "seconds": 0.8, "zoom": 1 }
  ]
}
```

- `focusX`/`focusY` (0–1) pick the point to zoom toward: `0, 0` is the top-left, `1, 1` the bottom-right.
- `at` is seconds from the clip start. Time each move to the UI event it points at, such as a click or a dialog opening, not to the clip length.
- Zoom values are at least 1. A move may set a new `focusX`/`focusY` only when it starts from zoom 1, where the switch is invisible; the editor rejects other focus changes.
- `startZoom` begins the clip already zoomed, which continues a zoom across a dissolve.
- `clockOffset` continues another clip's camera clock. Use it with `transitionAfter: 0` when one shot is split into two clips.

### Captions

Anchors are `[clipIndex, offsetSeconds]`, relative to that clip's start in the final video. Offsets may be negative, so `[4, -0.4]` means 0.4 s before clip 4 starts; `clips.length` means the end of the video. A cue must end after it starts. Anchors therefore stay correct when clips are trimmed. Captions fade over 0.3 s over a soft dark gradient in the lower left.

## Recording guide

- **One theme for every take.** Mixing themes is visible in cuts, and it forced the v8 cut to drop an entire scene.
- **Store raw recordings permanently**, not in `/tmp`. Without them, clips cannot be re-trimmed or re-framed.
- Record at 2400 × 1350 or more, at 30 fps, with a separate demo profile and repository. Use one window size throughout.
- Enlarge application text until tour cards and task titles are readable at 1080p. Hide unrelated projects, notifications, tokens and private paths.
- Keep 2 seconds of still footage before and after each action, so dissolves and zooms have room.
- Record real task creation and agent output. Cut waits instead of speeding footage up; label any sped-up footage.
- Check the tour and dialog layouts at 1080p before recording. Plan zooms for small UI such as tour cards and menus.

### How the v10 footage was captured

The v10 takes were recorded by an agent session that drove the app automatically. Its helper scripts lived in `/tmp` and were lost, so this is what is known, not a tested recipe:

- A small launcher started the compiled app (`dist-electron/main.js`) from an Electron entry script. Before import, it set `app.setPath('userData', …)` to a throwaway profile and `app.commandLine.appendSwitch('remote-debugging-port', '9334')`. It also set `VITE_DEV_SERVER_URL` to a separately running Vite dev server, and fixed each window at 1920 × 1080 with `setBounds`.
- A separate control script then drove the UI through that Chrome DevTools Protocol port. Its code was not kept.
- The screen recording method is unknown. The takes are 2400 × 1350 at 30 fps, which suggests a 1.25× device scale on the 1920 × 1080 window. The visible pointer was added in editing and is not the real cursor.
- The demo used a separate throwaway Git repository with fictional content.

To reproduce this, write the launcher and control script again, and keep them beside the raw takes, outside `/tmp`. For new footage, use the scripted recordings below instead.

## Scripted recordings

`npm run showcase:capture` builds the app and runs every scene in `scenes/`. Each scene drives the real app with Playwright and records it sharply to `.tmp/showcase/<scene>.mp4` (1920 × 1080, 30 fps). The cursor, captions, camera moves and cuts come from [`video-kit/`](video-kit/README.md), so a UI change means running the scene again, not recording it by hand.

Scripted recordings run on Linux only: the harness starts Linux's Electron binary with `--ozone-platform=headless`, and refuses to launch on other platforms.

`electron-app.ts` launches the built app with a throwaway home directory, a fictional `weather-app` repository and a seeded state whose "Demo agent" runs `scripts/fake-agent.mjs`. It passes only a short allowlist of environment variables (locale, `PATH` and proxy settings), so API keys and variables such as `CLAUDE_CONFIG_DIR` cannot lead the app back to real projects, sessions or tokens, and no paid agent runs. `recordScene` finalizes the video even when a scene fails. The app renders offscreen (`--ozone-platform=headless`), so no window opens and no GPU is needed; xterm then uses its DOM renderer, which stays sharp under camera zooms.

Real agents cannot start in a showcase run by default. Stubs named `claude`, `codex`, `gemini`, `opencode`, `copilot` and `agy` come first on `PATH` and exit with a message, even where a login survives the fake home (a CLI may keep it in the system keyring rather than a file). The app rebuilds its `PATH` from a login shell at startup, so the seeded `.zshrc`, `.bash_profile` and `.profile` put the stubs back in front after the system login files.

A scene that needs a real agent opts in with `launchShowcaseApp({ realAgents: ['claude'] })` (or `'codex'`). The stub then runs `pinned-agent.mjs`, which holds the agent to the provider's cheapest model:

- **Claude Code** always gets `--model haiku`. Any `--model` or `--fallback-model` argument is removed, and the `opus`/`sonnet` aliases and subagents also resolve to Haiku.
- **Codex** always gets `-c model="gpt-6-luna"`. Any `-m`/`--model`, `-p`/`--profile` or `-c model=…`/`profile=…` argument is removed. `codex app-server` (Codex chat) and `codex mcp-server` are refused, because they take the model per request.

Every other agent stays blocked. The pinning cannot stop a model typed into a running session by full ID (such as `/model claude-opus-…`), and it does not cover Docker-isolated tasks, whose agent runs inside the container. Change the models in `PINNED_MODELS`, not in scenes.

The app runs headless, so nobody can log in inside it. Opting in to `claude` therefore copies one file, your `~/.claude/.credentials.json`, into the throwaway home, and marks onboarding done and the demo repository trusted. The copy is deleted with the home, or when the test process exits without closing the app; only a killed process leaves it behind. The launch refuses a login that expires within 30 minutes: a token refresh during the run would rotate it in the copy and could sign out your real login. The Claude wrapper also turns off fast mode, your claude.ai connectors, auto-update and telemetry, and spinner tips. Codex has no login handling yet; add it the same way before using `realAgents: ['codex']`.

`scenes/real-agent.spec.ts` checks all of this with one Haiku prompt, billed to your Claude plan. It is skipped unless you ask for it:

```sh
SHOWCASE_REAL_AGENTS=1 npx playwright test --config scripts/showcase/playwright.config.ts real-agent
```

It confirms from `ps` that the running process has `--model haiku`, waits for Haiku's first permission question, and saves `.tmp/showcase/real-agent.png`.

### Demo tasks without agents

`launchShowcaseApp({ withTasks: true })` opens the app with three tasks already in flight, as in `scenes/overview.spec.ts`: one working, one waiting for input, one ready to merge. `demo-workspace.ts` gives each a real worktree whose changes match its story, and seeds its state. The app derives every status from the agent and from git, exactly as for a real agent, but no agent runs. Every seeded run uses the Noir theme, so stills and videos match.

Claude Code tasks open in chat view. Their history is a Claude session file written from `chats.ts` into the throwaway home, which the app reads when it resumes the chat. The live part comes from `chat-agent.mjs`: the blocked `claude` stub hands it every chat launch (`--input-format stream-json`), and it answers the CLI's protocol with the task's script instead of a model. A script can open with a permission request (the Sydney task's pending edit), and replies to a sent message without ever finishing, so the task reads as working. Allow, Decline and Stop still end the turn, so a live demo does not get stuck. Because the seeded chats are made up, `withTasks` cannot be combined with `realAgents: ['claude']`; the launch refuses it. The chat only starts working on a send, so scenes call `sendChatMessage(page, slug, text)`. Keep the chat's diffs consistent with the worktree. Delegation stays off (`mcpOrchestrationEnabled: false`): it needs a real agent connected to the app's MCP server, and would show a banner above every chat.

Other agents, such as the Gemini task, run `fake-agent.mjs --transcript` in their terminal: it prints a canned session from `transcripts.ts` and then waits; `--busy <label>` keeps a spinner going. Terminal text needs a process because the app keeps no scrollback on disk. Keep transcripts short (three columns share the window), and end one on a prompt for an idle agent, or on a question such as `[Y/n]` for one that needs input.

More options shape the seeded workspace:

- `planner: true` adds a fourth task, "Plan weather app v2" (a Claude chat), whose mind map (`canvases.ts`) links its nodes to the other three tasks.
- `focus: '<slug>'` opens that task in focus mode; `shell: true` gives it a shell terminal. The seeded rc files keep the shell prompt short.

The demo repository always lives at `$TMPDIR/pc-demo`, so paths in the UI stay short. A run deletes a leftover `pc-demo` only when it holds the `.parallel-code-showcase` marker and the process id in that marker is no longer running; otherwise it refuses. The demo repository's Git commands ignore your global and system Git config and commit as `Demo <demo@example.com>`.

To add a scene, copy `scenes/first-task.spec.ts`. Wait for the UI with `expect()` assertions; use fixed holds only for pacing. To run one scene: `npx playwright test --config scripts/showcase/playwright.config.ts first-task`.

### Screenshots

These scenes save a still to `.tmp/showcase/<scene>.png` (1920 × 1080). No agent runs:

| Scene         | Shows                                                                       |
| ------------- | --------------------------------------------------------------------------- |
| `overview`    | Three tasks working, waiting for input and ready to merge                   |
| `focus`       | One task in focus mode with notes and a shell                               |
| `diff-review` | An inline review comment on a changed line                                  |
| `change-tour` | The guided change tour; the blocked `claude` stub answers with a canned one |
| `reasoning`   | The Sydney task's reasoning graph, published as an agent would              |
| `mind-map`    | The planning task's mind map, with an agent adding nodes live               |
| `phone`       | The phone overview (1170 × 2532), grouped by what needs you                 |

`publishAsAgent` sends a canvas update over the same IPC channel an agent's MCP call uses, so the canvas shows it as live agent work. `clearCanvasSelection` clears the selection that would fade most nodes.

`phone` starts the phone server on port 18777 and opens it in Playwright's own Chromium, because Electron crashes opening a second window when headless. It needs `npm run build:remote` (part of `showcase:capture`) and a one-time `npx playwright install --only-shell chromium`.

## Checking the result

```sh
ffprobe -v error -show_entries stream=codec_type,width,height,r_frame_rate,nb_frames -of compact showcase.mp4
ffmpeg -v error -i showcase.mp4 -f null -   # full decode; prints nothing when clean
```

Also look at extracted frames around every cut, zoom and caption, then watch the video once at normal speed in a desktop player.
