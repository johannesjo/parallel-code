# Features

Everything beyond the core loop (create a task, review its diff, merge or discard it) is optional. This page describes each feature in detail; the [README](../README.md) has the short version.

## Workspace and navigation

- Tiled panel layout with drag-to-reorder
- **Focus mode** — single-task layout with a clean two-column view on wide screens (`Ctrl+Shift+F`)
- **Board** — every open task across projects in lanes by what it needs: Needs you, Stopped, Working, In pull request, Ready to merge, Snoozed & minimized (`Ctrl+Shift+G`). A pull request whose checks fail, that conflicts or has changes requested comes back to Needs you, unless Babysit is already sending the failures to its agent and has not got stuck (the agent exited, or went idle for six minutes without pushing a fix); Ready to merge shows once a pull request can merge. A task you click, or a new one, opens in a side panel beside the board; switch between Focus, Tiles and Board from the title bar. New installs open on a welcome screen that links the first project, then start on the Board. On the board, arrow keys (or `hjkl`) move between cards, `Enter` opens one beside it, `/` filters, and `Alt+Arrows` cross into the sidebar and the side panel. In the side panel, `Alt+Arrows` move between the task's panes and, past their edge, on to the next card that way; `Cmd+Opt+Up/Down` (macOS) or `Ctrl+Alt+Up/Down` and `Alt+PageUp/PageDown` (Linux, Windows) jump straight to the card above or below. `Ctrl+Tab` (also on macOS) goes to the next task that needs you, then to stopped ones, from anywhere in the app; `Ctrl+Shift+Tab` goes back up the same list
- **Command palette** — `Cmd+K` (macOS) or `Ctrl+Shift+J` (Linux, Windows) jumps to any open task or runs any shortcut action by name, including ones you have unbound. Each action shows its key, recently run actions come first, and a leading `>` searches actions only
- Shell terminals per task, scoped to the worktree
- State persists across restarts

## Reviewing changes

- Built-in diff viewer with inline review comments and per-commit navigation
- **Guided change tour** — click **Generate tour of changes** at the bottom right of a task's Changed Files panel to generate in the background while you work. **Automatic** scope includes the whole feature branch against its configured or detected base, including uncommitted work; on `main`, `master`, and `develop`, it includes only uncommitted changes. Choose **Current diff** to explicitly use the commit selector (All, Uncommitted, or a single commit). Uncaptured context stays omitted when reading a captured tour. Hover or focus the button for an explanation and the configured provider/model. The button shows a spinner and progress, then a green checkmark and **Start tour** when ready. Click **Start tour** to open the diff captured for the tour; it never opens automatically. Completed tours remain available when you close and reopen the tour; clicking the loading button cancels generation. Uses your configured code Q&A provider and aims for 4–6 concise stops; larger diffs use compact excerpts, and provider context limits still apply. Tours describe the supplied diff and do not verify test execution. Each stop is a card with a role label and a tone that flags risky or uncertain changes; **Ask** and **Go deeper** answer follow-ups under a stop with the diff as context. Jump between stops from the progress strip, or with the arrow keys and Home/End while the tour has focus. The button shows **Resume tour** when you left midway.
- **All tours** — click a progress segment to jump to that card (a dot marks cards with answered follow-ups), copy the tour with its answers as Markdown, or **Rework** it with your own instructions ("focus on error handling", "for a newcomer"), which regenerates it from the same context. Code references open at their line when your editor command is VS Code, Cursor, VSCodium, Windsurf, Zed or Sublime Text; other editors open the file.
- **Understanding tours** — **Take Tour** beside **Review Plan** (and in the plan viewer's header) explains the plan; **Understand** on a changed-file row explains that file. Both open a short card tour: a gist, then 3–7 cards with **Ask** and **Go deeper**. Plan, document and agent tours read like slides: a claim, a few short points, and collapsed notes. Every answer becomes a card under the card it was asked on; ← → move along one level, ↓ ↑ go into and out of answers, and an outline of every card sits beside the card on wide windows. **Save tour** writes the tour with its answers to a `.tour.md` file in the worktree, which opens again from the canvas with **Open Tour**; **Reference in chat** puts the card on screen into the agent's prompt. See [tour-outline.md](tour-outline.md). They use the same code Q&A provider setting as the change tour and inline Q&A, and run without tools: a plan tour sends the plan markdown, a file tour sends the file plus its direct imports (size-capped; anything omitted is listed on the gist card). Unsaved tours live in memory for as long as the task panel is open and are discarded when you switch tasks. A reopened file tour whose file has changed shows a **Regenerate** notice instead of silently going stale. Free-form subsystem questions ("how does X work?") are not supported yet.
- **Confidence ratings** — **Run review** in the Finish dialog sends your prompts, the branch diff and the results of the checks you picked to a separate reviewer model (Settings › Review), so the task's agent never rates its own work. The reviewer can read the repository but not change it (Claude gets only file-reading tools; Codex runs in its read-only sandbox), and each score lists what it checked. **Rework** puts the findings you picked into one prompt that asks the agent to check each before changing code for it. The review runs in the background and notifies you when it is done. An agent can also publish a rating with the `confidence_publish` MCP tool. Low scores are highlighted, and a rating is marked out of date once the code changes after it
- **Before-and-after screenshots** — **Capture before & after** in the Finish dialog (needs Claude Code) works out how to start the task's version and the base version of your app, shows those commands and runs them only once you allow it, then screenshots each changed page side by side and stops every process it started
- **Coverage radar** — per-file test-coverage badges in the Changed Files panel

## Planning and coordinating agents

- **Project plan** — the checklist icon on a project row opens the project's plan, a Kanban board of planned work, inside the Board view, kept as plain Markdown in `KANBAN.md` (Obsidian Kanban compatible). Start a task from any card; the card follows its task to In progress, Review and Done, shows when the agent needs input, and links to the task. Cards can carry a checklist (acceptance criteria), dependencies and a GitHub issue, added from the plan or the GitHub page. **Plan with agent** lets an agent break a goal into cards. See [kanban.md](kanban.md)
- **Agent orchestration** — with Settings → Agents → **Allow agents to orchestrate tasks** turned on, a supported agent in a worktree task can create Parallel Code tasks through MCP, send them prompts, wait for them to finish and review their results. Child tasks are ordinary tasks in the app, each with its own worktree. They launch extra agent sessions, which may incur provider charges; the concurrent child limit is not a spending cap
- **Arena** — **Arena** in the sidebar footer runs the same prompt with two to four agents, each in its own worktree, then lets you compare their changes, rate them and merge the one you want
- **Mind map and reasoning graph** — two canvases per task: a mind map of ideas you own, with branches linked to live tasks, and the agent's reasoning graph of goals, options, evidence and decisions, updated as it works. See [mind-map.md](mind-map.md) and [reasoning-graph.md](reasoning-graph.md)
- **Task brief** — after each agent turn, a model rewrites a short brief from the turn's prompts, the agent's last message and the branch diff (Claude Haiku or Sonnet, GPT-6-Luna or GPT-6.1-Terra; Settings → **Briefs model**): the task's goal, the step it is at now, and what the agent needs from you, if anything, each in one sentence. A line under the task title shows the goal, or what the agent needs from you, tinted only then; click it for the current step. For details, ask the agent. Off by default; turn it on under Settings → **Write task briefs**
- **Notes panel per task** — jot ideas, then send the notes straight to the agent as a prompt
- **Canvas per task** — a Markdown file from the worktree rendered live as the agent writes it; edit it in place, or select a passage and send it to the agent with your question

## Running and isolating code

- **Browser preview in the canvas** — run a local app in the task shell, open **+ → Browser**, and pick elements to reference in your prompt ([usage and limits](browser-preview.md))
- **Sandboxing with project-specific Dockerfiles** — drop a `.parallel-code/Dockerfile` into the project and tasks run inside it

### Antigravity CLI: run natively, not in Docker isolation

Antigravity (`agy`) signs in interactively and caches credentials in your OS keyring (Keychain/libsecret). The keyring cannot be reached from inside a Linux container — it needs a secret-service daemon the agent container doesn't run — and `agy` has no API-key fallback, so **Docker-isolated Antigravity tasks cannot authenticate. Run Antigravity as a native (non-Docker) task.**

The bundled image still ships the `agy` binary, and `~/.gemini/antigravity-cli` (settings/plugins) is shared when "Share agent auth" is enabled, so Docker support is forward-compatible if a file-based or API-key auth path appears later.

## More ways to work

- **Direct mode** for working on the main branch without isolation, plus support for **folders without a git repo**
- **Existing worktree import** — bring already-created worktrees into Parallel Code

## Integrations and notifications

- **PR CI status watcher** — desktop notification when GitHub checks settle
- **Super Productivity integration** — the task you focus is tracked in Super Productivity (a matching task is created there on first focus, in the Super Productivity project you link in project settings), titles stay in sync, and merging or closing a task marks it done there. A task Super Productivity is already tracking that isn't a Parallel Code task is never replaced — a banner offers to switch instead. Connect in Settings with the token from Super Productivity's Local REST API (Settings → Misc; the API must stay turned on). With Super Productivity's bundled **Parallel Code** plugin enabled, **Start in Parallel Code** on a task opens a pre-filled New Task form here; that link needs the macOS app or the `.deb` (an AppImage only handles it if it was integrated into your desktop).
- **Code Q&A provider** — inline code questions, change tours and understanding tours use [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (default) or [MiniMax](https://www.minimax.io/) M2.7 (204K context), configurable in Settings
- **Phone access** — follow your agents and reply to them from a phone. See [phone.md](phone.md)

## Customization

- **Configurable keyboard shortcuts** with per-agent presets
- **Custom agents** — add any other terminal agent under Settings → Agents → **Custom agents**
- 10 themes — Islands Dark, Minimal, Graphite, Midnight, Classic, Indigo, Ember, Glacier, Zenburnesque, Workbench

## Keyboard shortcuts

`Ctrl` = `Cmd` on macOS.

| Shortcut               | Action                                     |
| ---------------------- | ------------------------------------------ |
| **Tasks**              |                                            |
| `Ctrl+N`               | New task                                   |
| `Ctrl+Shift+A`         | New task (alternative)                     |
| `Ctrl+Enter`           | Send prompt                                |
| `Ctrl+Shift+M`         | Finish task (merge or push)                |
| `Ctrl+W`               | Close focused panel or file                |
| `Ctrl+Shift+W`         | Close active task                          |
| **Navigation**         |                                            |
| `Alt+Arrows`           | Focus pane/task in arrow direction         |
| `Alt+Shift+Left/Right` | Move task (macOS: `Ctrl+Shift`)            |
| `Ctrl+Shift+J`         | Switch task or run action (Linux, Windows) |
| `Cmd+K`                | Switch task or run action (macOS)          |
| `Ctrl+B`               | Toggle sidebar                             |
| `Ctrl+Shift+F`         | Toggle focus mode                          |
| `Ctrl+Shift+G`         | Toggle the board of running tasks          |
| `Ctrl+Tab`             | Next waiting task (Ctrl on macOS)          |
| `Ctrl+Shift+Tab`       | Previous waiting task                      |
| **Terminals**          |                                            |
| `Ctrl+Shift+T`         | New shell terminal                         |
| `Ctrl+Shift+D`         | New standalone terminal                    |
| **App**                |                                            |
| `Ctrl+,`               | Open settings                              |
| `Ctrl+/` or `F1`       | Show all shortcuts                         |
| `Ctrl+=` / `Ctrl+-`    | Zoom in / out                              |
| `Ctrl+0`               | Reset zoom                                 |
| `Ctrl+Scroll`          | Adjust zoom                                |
| `Escape`               | Close dialog, board or focus mode          |
