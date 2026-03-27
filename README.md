<p align="center">
  <img src="build/logo-text-squared.svg" alt="Parallel Code" height="76">
</p>

<p align="center">
  Run Claude Code agents in parallel. Each task gets its own terminal, branch, and worktree.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-47848F?logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/SolidJS-2C4F7C?logo=solid&logoColor=white" alt="SolidJS">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Linux-lightgrey" alt="macOS | Linux">
</p>

## What is this

A desktop app for running multiple Claude Code agents at the same time, each isolated in its own git worktree. Think of it as a terminal multiplexer purpose-built for AI coding.

Type a prompt, hit Enter. A branch is created, a worktree is set up, Claude Code launches with `--dangerously-skip-permissions`, and you see it work in a full-screen terminal. Run five agents on five features simultaneously. Merge when you're happy.

## Quick Start

```sh
git clone https://github.com/drewAnderson-val/parallel-code.git
cd parallel-code
npm install
npm run dev
```

Requires [Node.js](https://nodejs.org/) v18+ and [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

## How it works

1. **Click `+`** in the tab bar, type what you want done, hit Enter
2. A git branch + worktree is created from main
3. Claude Code spawns in that worktree — full-screen terminal, no UI clutter
4. Work on multiple tasks side by side — drag the divider to resize
5. Use the tab dropdown to **create a PR**, **merge**, **push**, or **close**

## Tab Actions

Click the `▾` on any tab:

| Action             | What it does                           |
| ------------------ | -------------------------------------- |
| Create PR          | `gh pr create --fill` in the worktree  |
| Open PR in Browser | `gh pr view --web`                     |
| Push to Remote     | Pushes the task branch                 |
| Merge to Main      | Squash merge back to main              |
| Rebase onto Main   | Rebase the task branch                 |
| Open in Editor     | Opens worktree in your editor          |
| Close Task         | Kills agent, removes worktree + branch |

## Keyboard Shortcuts

`Ctrl` = `Cmd` on macOS.

| Shortcut       | Action          |
| -------------- | --------------- |
| `Ctrl+Enter`   | Send prompt     |
| `Ctrl+Shift+M` | Merge to main   |
| `Ctrl+Shift+P` | Push to remote  |
| `Ctrl+W`       | Close terminal  |
| `Ctrl+Shift+W` | Close task      |
| `Alt+Arrows`   | Navigate panels |
| `Ctrl+B`       | Toggle sidebar  |
| `Ctrl+,`       | Settings        |
| `Ctrl+0`       | Reset zoom      |

## Credits

Built on top of [johannesjo/parallel-code](https://github.com/johannesjo/parallel-code) — the original project that pioneered the worktree-per-agent concept. This fork redesigns the UI for a terminal-first, Warp-inspired experience focused exclusively on Claude Code.

## License

MIT
