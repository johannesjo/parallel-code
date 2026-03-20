<p align="center">
  <img src="build/logo-text-squared.svg" alt="Parallel Code" height="76">
</p>

<p align="center">
  Turn wait time into parallel progress.
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

**Parallel Code** is a desktop app that gives every AI coding agent its own git branch and worktree — automatically.

## Screenshots

| Agent working on a task                     | Commit & merge workflow           |
| ------------------------------------------- | --------------------------------- |
| ![Agent working](screens/agent-working.png) | ![Workflow](screens/workflow.png) |
| **Direct mode (main branch)**               | **Themes**                        |
| ![Direct mode](screens/direct-mode.png)     | ![Themes](screens/themes.png)     |

## Why Parallel Code?

- **Use the AI coding tools you already trust** — [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli) — all from one interface.
- **Free and open source** — no extra subscription required. MIT licensed.
- **Keep every change isolated and reviewable** — each task gets its own git branch and worktree automatically.
- **Run agents in parallel, not in sequence** — five agents on five features at the same time, zero conflicts.
- **See every session in one place** — switch context without losing momentum.
- **Control everything keyboard-first** — every action has a shortcut, mouse optional.
- **Monitor progress from your phone** — scan a QR code, watch agents work over Wi-Fi or Tailscale.

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
- Built-in diff viewer and changed files list per task
- Shell terminals per task, scoped to the worktree
- Direct mode for working on the main branch without isolation
- Six themes — Minimal, Graphite, Classic, Indigo, Ember, Glacier
- State persists across restarts
- macOS and Linux

</details>

## Demo

<p align="center">
  <video src="screens/showcase.mp4" width="800" controls></video>
</p>

## Getting Started

1. **Download** the latest release for your platform from the [releases page](https://github.com/johannesjo/parallel-code/releases/latest):
   - **macOS** — `.dmg` (universal)
   - **Linux** — `.AppImage` or `.deb`

2. **Install at least one AI coding CLI:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex), or [Gemini CLI](https://github.com/google-gemini/gemini-cli)

3. **Open Parallel Code**, point it at a git repo, and start dispatching tasks.

<details>
<summary><strong>Build from source</strong></summary>

```sh
git clone https://github.com/johannesjo/parallel-code.git
cd parallel-code
npm install
npm run dev
```

Requires [Node.js](https://nodejs.org/) v18+.

</details>

<details>
<summary><strong>Keyboard Shortcuts</strong></summary>

`Ctrl` = `Cmd` on macOS.

| Shortcut              | Action                         |
| --------------------- | ------------------------------ |
| **Tasks**             |                                |
| `Ctrl+N`              | New task                       |
| `Ctrl+Shift+A`        | New task (alternative)         |
| `Ctrl+Enter`          | Send prompt                    |
| `Ctrl+Shift+M`        | Merge task to main             |
| `Ctrl+Shift+P`        | Push to remote                 |
| `Ctrl+W`              | Close focused terminal session |
| `Ctrl+Shift+W`        | Close active task              |
| **Navigation**        |                                |
| `Alt+Arrows`          | Navigate between panels        |
| `Ctrl+Alt+Left/Right` | Reorder active task            |
| `Ctrl+B`              | Toggle sidebar                 |
| **Terminals**         |                                |
| `Ctrl+Shift+T`        | New shell terminal             |
| `Ctrl+Shift+D`        | New standalone terminal        |
| **App**               |                                |
| `Ctrl+,`              | Open settings                  |
| `Ctrl+/` or `F1`      | Show all shortcuts             |
| `Ctrl+0`              | Reset zoom                     |
| `Ctrl+Scroll`         | Adjust zoom                    |
| `Escape`              | Close dialog                   |

</details>

---

If Parallel Code saves you time, consider giving it a [star on GitHub](https://github.com/johannesjo/parallel-code). It helps others find the project.

## License

MIT
