<p align="center">
  <img src="build/logo-text-squared.svg" alt="Parallel Code" height="76">
</p>

<p align="center">
  <strong>Ten agents.<br>
  Ten branches.<br>
  One afternoon.</strong>
</p>

<p align="center">
  Dispatch AI coding agents in parallel, each in its own worktree.<br>
  Review the diffs, merge the wins, toss the rest.
</p>

<p align="center">
  Works with Claude Code, Codex, Gemini, and Docker-pinned Kimi Code · Every change isolated in its own git worktree · Free, open source, no extra platform fee
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-47848F?logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/SolidJS-2C4F7C?logo=solid&logoColor=white" alt="SolidJS">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Linux-lightgrey" alt="macOS | Linux">
  <img src="https://img.shields.io/github/license/johannesjo/parallel-code" alt="License">
</p>

<p align="center">
  <a href="https://youtu.be/sLf0tsQA3pU">
    <img src="https://img.shields.io/badge/Watch%20Intro-YouTube-red?logo=youtube&logoColor=white&style=for-the-badge" alt="Watch intro on YouTube">
  </a>
</p>

<p align="center">
  <img src="screens/longer-video.gif" alt="Parallel Code demo" width="800">
</p>

## Screenshots

| Multiple agents in parallel                           | Focused view on a single task                 |
| ----------------------------------------------------- | --------------------------------------------- |
| ![Overview](screens/islands-overview.png)             | ![Focus view](screens/islands-focus-view.png) |
| **Diff review with inline comments**                  | **AI Arena — race agents head-to-head**       |
| ![Diff review](screens/diff-dialog-code-comments.png) | ![AI Arena](screens/ai-arena-mode.png)        |

## Why Parallel Code?

- **Use the AI coding tools you already trust** — [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli), Docker-pinned [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code), and [Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli) — all from one interface.
- **Free and open source** — no extra subscription required. MIT licensed.
- **Keep every change isolated and reviewable** — each task gets its own git branch and worktree automatically.
- **Run agents in parallel, not in sequence** — five agents on five features at the same time, zero conflicts.
- **See every session in one place** — switch context without losing momentum.
- **Control everything keyboard-first** — every action has a shortcut, mouse optional.
- **Monitor progress from your phone** — scan a QR code, watch agents work over Wi-Fi or Tailscale.
- **Ask about code with any LLM** — the inline code Q&A feature supports [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (default) or [MiniMax](https://www.minimax.io/) M2.7 (204K context) — configurable in Settings.

<details>
<summary><strong>How does it compare?</strong></summary>

| Approach                                           | What's missing                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Multiple terminal windows / tmux**               | No GUI, no automatic git isolation — you manage worktrees, branches, and merges by hand |
| **VS Code extensions** (Kilo Code, Roo Code, etc.) | Tied to VS Code; no true parallel worktree isolation between agents                     |
| **Running agents sequentially**                    | One task at a time — blocks your workflow while each agent finishes                     |

</details>

## How it works

When you create a task, Parallel Code:

1. Creates a new git branch from your main branch
2. Sets up a [git worktree](https://git-scm.com/docs/git-worktree) so the agent works in a separate directory
3. Symlinks `node_modules` and other gitignored directories into the worktree
4. Spawns the AI agent in that worktree

When you're happy with the result, merge the branch back to main from the sidebar.

<details>
<summary><strong>More features</strong></summary>

- Tiled panel layout with drag-to-reorder
- **Focus mode** — single-task layout with a clean two-column view on wide screens (`Ctrl+Shift+F`)
- Built-in diff viewer with inline review comments and per-commit navigation
- **Guided change tour** — click **Generate tour of changes** at the bottom right of a task's Changed Files panel to generate in the background while you work. **Automatic** scope includes the whole feature branch against its configured or detected base, including uncommitted work; on `main`, `master`, and `develop`, it includes only uncommitted changes. Choose **Current diff** to explicitly use the commit selector (All, Uncommitted, or a single commit). Uncaptured context stays omitted when reading a captured tour. Hover or focus the button for an explanation and the configured provider/model. The button shows a spinner and progress, then a green checkmark and **Start tour** when ready. Click **Start tour** to open the diff captured for the tour; it never opens automatically. Completed tours remain available when you close and reopen the tour; clicking the loading button cancels generation. Uses your configured code Q&A provider, aiming for 4–6 concise stops in one request with a dedicated 500,000-character prompt budget; inline Q&A keeps its 50,000-character limit. This is an app guard, not an exact token limit—provider context limits still apply. Larger diffs use compact excerpts and a five-minute timeout per part. Claude tour prompts are piped through stdin to avoid command-line size limits. Verbose logs include request sizes, time to first output, and total request duration, without code or response contents. Tours describe the supplied diff and do not verify test execution. Each stop is a card with a role label and a tone that flags risky or uncertain changes; **Ask** and **Go deeper** answer follow-ups under a stop with the diff as context. Jump between stops from the progress strip, or with the arrow keys and Home/End while the tour has focus. The button shows **Resume tour** when you left midway.
- **All tours** — click a progress segment to jump to that card (a dot marks cards with answered follow-ups), copy the tour with its answers as Markdown, or **Rework** it with your own instructions ("focus on error handling", "for a newcomer"), which regenerates it from the same context. Code references open at their line when your editor command is VS Code, Cursor, VSCodium, Windsurf, Zed or Sublime Text; other editors open the file.
- **Understanding tours** — **Take Tour** beside **Review Plan** (and in the plan viewer's header) explains the plan; **Understand** on a changed-file row explains that file. Both open a short card tour: a gist, then 3–7 cards with **Ask** and **Go deeper**, which generate a small branch you return from. They use the same code Q&A provider setting as the change tour and inline Q&A, and run without tools: a plan tour sends the plan markdown, a file tour sends the file plus its direct imports (size-capped; anything omitted is listed on the gist card). Tours live in memory for as long as the task panel is open and are discarded when you switch tasks. A reopened file tour whose file has changed shows a **Regenerate** notice instead of silently going stale. Free-form subsystem questions ("how does X work?") are not supported yet.
- **Steps tracking panel** — engineering-manager-style timeline of agent progress (writes to `.claude/steps.json`)
- **Notes panel per task** — jot ideas, then send the notes straight to the agent as a prompt
- **Canvas per task** — a Markdown file from the worktree rendered live as the agent writes it; edit it in place, or select a passage and send it to the agent with your question
- **Browser preview in the canvas** — run a local app in the task shell, open **+ → Browser**, and pick elements to reference in your prompt ([usage and limits](docs/browser-preview.md))
- **PR CI status watcher** — desktop notification when GitHub checks settle
- **Super Productivity integration** — the task you focus is tracked in Super Productivity (a matching task is created there on first focus, in the Super Productivity project you link in project settings), titles stay in sync, and merging or closing a task marks it done there. A task Super Productivity is already tracking that isn't a Parallel Code task is never replaced — a banner offers to switch instead. Connect in Settings with the token from Super Productivity's Local REST API (Settings → Misc; the API must stay turned on). With Super Productivity's bundled **Parallel Code** plugin enabled, **Start in Parallel Code** on a task opens a pre-filled New Task form here; that link needs the macOS app or the `.deb` (an AppImage only handles it if it was integrated into your desktop).
- Shell terminals per task, scoped to the worktree
- **Direct mode** for working on the main branch without isolation, plus support for **folders without a git repo**
- **Existing worktree import** — bring already-created worktrees into Parallel Code
- **Sandboxing with project-specific Dockerfiles** — drop a `.parallel-code/Dockerfile` into the project and tasks run inside it
- **Coverage radar** — per-file test-coverage badges in the Changed Files panel
- **Configurable keyboard shortcuts** with per-agent presets
- 10 themes — Islands Dark, Minimal, Graphite, Midnight, Classic, Indigo, Ember, Glacier, Zenburnesque, Workbench
- State persists across restarts
- macOS and Linux

</details>

## Demo

<p align="center">
  <a href="screens/showcase.mp4">
    <img src="screens/best-video.gif" alt="Watch the demo" width="800">
  </a>
</p>

<p align="center">
  <em><a href="screens/showcase.mp4">▶ Watch the showcase (MP4)</a></em>
</p>

## Getting Started

1. **Download** the latest release for your platform from the [releases page](https://github.com/johannesjo/parallel-code/releases/latest):
   - **macOS** — `.dmg` (universal)
   - **Linux** — `.AppImage` or `.deb`

2. **Install at least one AI coding CLI:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Antigravity CLI](https://antigravity.google/), or [Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli). Kimi Code is currently supported through the bundled Docker image instead of a native installation.

3. **Open Parallel Code**, point it at a git repo, and start dispatching tasks.

<details>
<summary><strong>Kimi Code: use Docker mode</strong></summary>

Parallel Code's Kimi integration writes an auto-discovered project MCP config into each fresh
task worktree. Kimi Code 0.33 added a workspace-trust prompt, and 0.36 defaults to declining
project MCP launch targets in that prompt. A current native Kimi installation can therefore
pause on every new worktree instead of starting the task unattended.

Use Docker-isolated Kimi tasks for now. The bundled image pins Kimi Code 0.32, before the
workspace-trust gate. Native Kimi support is not currently claimed.
Kimi is hidden from native task agent pickers, and native launches (including saved/custom
`kimi` definitions) are rejected with an actionable Docker-mode error. Existing running
terminals can still reattach after a renderer reload.

</details>

<details>
<summary><strong>Antigravity CLI: run natively, not in Docker isolation</strong></summary>

Antigravity (`agy`) signs in interactively and caches credentials in your OS keyring (Keychain/libsecret). The keyring cannot be reached from inside a Linux container — it needs a secret-service daemon the agent container doesn't run — and `agy` has no API-key fallback, so **Docker-isolated Antigravity tasks cannot authenticate. Run Antigravity as a native (non-Docker) task.**

The bundled image still ships the `agy` binary, and `~/.gemini/antigravity-cli` (settings/plugins) is shared when "Share agent auth" is enabled, so Docker support is forward-compatible if a file-based or API-key auth path appears later.

</details>

<details>
<summary><strong>Build from source</strong></summary>

```sh
git clone https://github.com/johannesjo/parallel-code.git
cd parallel-code
npm install
npm run dev
```

Requires [Node.js](https://nodejs.org/) v18+.

Phone access uses port `8777` in development (`npm run dev`) and `7777` in the installed app, so both can run together. Run `npm run build:remote` after changing the mobile UI, then use **Connect Phone** in the development app to get its connection link or QR code.

</details>

## Android app

The phone UI works in any mobile browser. On Android, the native app adds agent notifications that need no HTTPS setup, a home-screen widget, and voice input.

1. On your phone, open the [Android releases](https://github.com/johannesjo/parallel-code/releases?q=android-v&expanded=true) and download the newest `parallel-code-phone-*.apk`.
2. Open the downloaded file. Android asks you to allow installs from your browser the first time.
3. In the app, scan the QR code from **Connect Phone** or paste its link, then enter the desktop PIN to enable replies.

The app is not in the Play Store yet. It checks GitHub for a newer release once a day and offers the download; you can turn that off under **Settings → About**. [Obtainium](https://github.com/ImranR98/Obtainium) can also install and update it: add `https://github.com/johannesjo/parallel-code` and filter release titles by `Android`.

Its notifications come from your computer over the same connection as the app, so the phone has to be able to reach your computer, on the same Wi-Fi or through Tailscale. Turning them on keeps a quiet notification visible while the app watches in the background.

## Phone notifications

Paired phones can receive a notification when a running task changes to **Needs input**, including while the phone is locked or the phone app is closed. Tap the notification to open that task. Parallel Code must remain running on your computer with phone access enabled, and both devices need internet access for push delivery.

1. Open the phone UI over **HTTPS**. The ordinary Wi-Fi and Tailscale IP links use HTTP and cannot enable browser push. One option is [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve): with both devices on your tailnet, run `tailscale serve --bg http://127.0.0.1:7777` on your computer (use the port shown in **Connect Phone**, normally `8777` in development). Follow Tailscale's HTTPS setup prompts.
2. Copy the connection link from **Connect Phone** and replace its `http://IP:PORT` part with the HTTPS address printed by Serve, keeping `?token=…`. Open that link on your phone and authorize it with the desktop PIN. Choose **Keep this device authenticated** to retain notifications across computer restarts.
3. On iPhone/iPad (iOS/iPadOS 16.4 or later), use **Add to Home Screen**, then open the app from that icon and authorize it there if asked. [Apple requires a Home Screen web app for Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).
4. In **Your tasks → Task notifications**, tap **Enable notifications** and allow notifications when your phone asks. You can turn them off in the same place. Disconnecting phones on the desktop revokes their notifications too.

Notifications show the task name and a request for input; terminal output and connection credentials are not included. Opening a task still requires a connection to your computer. A different HTTPS proxy can also be used at the origin root; it must preserve the original `Host` header and forward WebSockets.

<details>
<summary><strong>Keyboard Shortcuts</strong></summary>

`Ctrl` = `Cmd` on macOS.

| Shortcut               | Action                             |
| ---------------------- | ---------------------------------- |
| **Tasks**              |                                    |
| `Ctrl+N`               | New task                           |
| `Ctrl+Shift+A`         | New task (alternative)             |
| `Ctrl+Enter`           | Send prompt                        |
| `Ctrl+Shift+M`         | Finish task (merge or push)        |
| `Ctrl+W`               | Close focused panel or file        |
| `Ctrl+Shift+W`         | Close active task                  |
| **Navigation**         |                                    |
| `Alt+Arrows`           | Focus pane/task in arrow direction |
| `Alt+Shift+Left/Right` | Move task (macOS: `Ctrl+Shift`)    |
| `Ctrl+B`               | Toggle sidebar                     |
| `Ctrl+Shift+F`         | Toggle focus mode                  |
| **Terminals**          |                                    |
| `Ctrl+Shift+T`         | New shell terminal                 |
| `Ctrl+Shift+D`         | New standalone terminal            |
| **App**                |                                    |
| `Ctrl+,`               | Open settings                      |
| `Ctrl+/` or `F1`       | Show all shortcuts                 |
| `Ctrl+0`               | Reset zoom                         |
| `Ctrl+Scroll`          | Adjust zoom                        |
| `Escape`               | Close dialog                       |

</details>

---

If Parallel Code saves you time, consider giving it a [star on GitHub](https://github.com/johannesjo/parallel-code). It helps others find the project.

## License

MIT
