# Parallel Code

A desktop app for running multiple AI coding agents side by side, each in their own isolated git worktree.

![Parallel Code demo](screens/demo.gif)

Parallel Code lets you dispatch tasks to AI coding agents — Claude Code, Codex CLI, or Gemini CLI — and watch them work simultaneously. Each task gets its own git branch and worktree, so agents never step on each other's code. When a task is done, merge it back to main with one click.

## Screenshots

| Agent working on a task | Commit & merge workflow |
| --- | --- |
| ![Agent working](screens/agent-working.png) | ![Workflow](screens/workflow.png) |

| Direct mode (main branch) | Themes |
| --- | --- |
| ![Direct mode](screens/direct-mode.png) | ![Themes](screens/themes.png) |

## Features

### One app for every AI coding CLI
Use [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex), and [Gemini CLI](https://github.com/google-gemini/gemini-cli) from the same interface. Switch between agents per task, or run all three at once — no juggling terminal windows.

### Automatic branches and worktrees
Every task gets its own git branch and [worktree](https://git-scm.com/docs/git-worktree) instantly. Agents work in full isolation — no conflicts, no stashing, no waiting. Five agents, five features, one repo. Merge back to main when you're done.

### Keyboard-first, zero friction
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

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [npm](https://www.npmjs.com/) (comes with Node.js)
- At least one AI coding CLI installed: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex), or [Gemini CLI](https://github.com/google-gemini/gemini-cli)

### Install & Run

```sh
git clone https://github.com/your-username/parallel-code.git
cd parallel-code
npm install
npm run dev
```

## How It Works

When you create a task, Parallel Code:

1. Creates a new git branch from your main branch
2. Sets up a [git worktree](https://git-scm.com/docs/git-worktree) so the agent works in a separate directory
3. Symlinks `node_modules` and other gitignored directories into the worktree
4. Spawns the AI agent in that worktree

This means you can have five agents working on five different features at the same time, all from the same repo, with zero conflicts. When you're happy with the result, merge the branch back to main from the sidebar.

## Keyboard Shortcuts

`Ctrl` = `Cmd` on macOS.

| Shortcut | Action |
| --- | --- |
| **Tasks** | |
| `Ctrl+N` | New task |
| `Ctrl+Shift+A` | New task (alternative) |
| `Ctrl+Enter` | Send prompt |
| `Ctrl+Shift+M` | Merge task to main |
| `Ctrl+Shift+P` | Push to remote |
| `Ctrl+W` | Close focused terminal session |
| `Ctrl+Shift+W` | Close active task |
| **Navigation** | |
| `Alt+Arrows` | Navigate between panels |
| `Ctrl+Alt+Left/Right` | Reorder active task |
| `Ctrl+B` | Toggle sidebar |
| **Terminals** | |
| `Ctrl+Shift+T` | New shell terminal |
| `Ctrl+Shift+D` | New standalone terminal |
| **App** | |
| `Ctrl+,` | Open settings |
| `Ctrl+/` or `F1` | Show all shortcuts |
| `Ctrl+0` | Reset zoom |
| `Ctrl+Scroll` | Adjust zoom |
| `Escape` | Close dialog |

## Built With

[Electron](https://www.electronjs.org/) · [SolidJS](https://www.solidjs.com/) · [Node.js](https://nodejs.org/) · [xterm.js](https://xtermjs.org/)

## License

MIT
