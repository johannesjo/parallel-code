<p align="center">
  <img src="build/logo-text-squared.svg" alt="Parallel Code" height="76">
</p>

<p align="center">
  Run multiple AI coding agents without the chaos.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-47848F?logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/SolidJS-2C4F7C?logo=solid&logoColor=white" alt="SolidJS">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Linux-lightgrey" alt="macOS | Linux">
  <img src="https://img.shields.io/github/license/johannesjo/parallel-code" alt="License">
</p>

<p align="center">
  <img src="screens/longer-video.gif" alt="Parallel Code demo" width="800">
</p>

**Parallel Code** gives Claude Code, Codex CLI, and Gemini CLI each their own git branch and worktree — automatically. No agents stepping on each other's code, no juggling terminals, no mental overhead. Just one clean interface where you can see everything, navigate fast, merge results when they're ready — and monitor it all from your phone.

## Screenshots

| Agent working on a task                     | Commit & merge workflow           |
| ------------------------------------------- | --------------------------------- |
| ![Agent working](screens/agent-working.png) | ![Workflow](screens/workflow.png) |
| **Direct mode (main branch)**               | **Themes**                        |
| ![Direct mode](screens/direct-mode.png)     | ![Themes](screens/themes.png)     |

## Why Parallel Code?

Running multiple AI coding agents is powerful — but chaotic. On the same branch, agents interfere with each other's code. Across terminals, you lose track of what's happening where. Setting up feature branches and worktrees manually works, but adds cognitive load you shouldn't have to deal with.

| Approach                                           | What's missing                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Multiple terminal windows / tmux**               | No GUI, no automatic git isolation — you manage worktrees, branches, and merges by hand |
| **VS Code extensions** (Kilo Code, Roo Code, etc.) | Tied to VS Code; no true parallel worktree isolation between agents                     |
| **Running agents sequentially**                    | One task at a time — blocks your workflow while each agent finishes                     |

Parallel Code combines a dedicated GUI, automatic worktree isolation, and multi-agent orchestration into one app — so you can dispatch five tasks and walk away.

## How Parallel Code Solves It

When you create a task, Parallel Code:

1. Creates a new git branch from your main branch
2. Sets up a [git worktree](https://git-scm.com/docs/git-worktree) so the agent works in a separate directory
3. Symlinks `node_modules` and other gitignored directories into the worktree
4. Spawns the AI agent in that worktree

This means you can have five agents working on five different features at the same time, all from the same repo, with zero conflicts. When you're happy with the result, merge the branch back to main from the sidebar.

## Features

### One interface, every AI coding agent

Use [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex), and [Gemini CLI](https://github.com/google-gemini/gemini-cli) from the same interface. Switch between agents per task, or run all three at once — no juggling terminal windows.

### 5 agents, 5 features, zero conflicts

Every task gets its own git branch and [worktree](https://git-scm.com/docs/git-worktree) instantly. Agents work in full isolation — no conflicts, no stashing, no waiting. Five agents, five features, one repo. Merge back to main when you're done.

### Walk away — monitor from your phone

Scan a QR code and watch all your agent terminals live on your phone — over Wi-Fi or Tailscale. Step away from your desk while your agents keep working.

### Keyboard-first, mouse-optional

Navigate panels, create tasks, send prompts, merge branches, push to remote — all without touching the mouse. Every action has a shortcut, and `Ctrl+/` shows them all.

### And more

- Tiled panel layout with drag-to-reorder
- Built-in diff viewer and changed files list per task
- Shell terminals per task, scoped to the worktree
- Direct mode for working on the main branch without isolation
- Six themes — Minimal, Graphite, Classic, Indigo, Ember, Glacier
- State persists across restarts
- macOS and Linux

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
