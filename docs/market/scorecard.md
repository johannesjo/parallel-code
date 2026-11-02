# Market scorecard

**Snapshot 2026-10** · PC v5.1.0, plus unreleased changes on `main` up to
`f49c16c` (2026-10-28) · target, competitor set and method: [README.md](README.md)

How this snapshot was gathered:

- **PC facts** were read from the code at the v5.1.0 tag. Later changes on `main`
  are listed under [Unreleased on main](#unreleased-on-main).
- **Competitor facts** come from GitHub (repositories, READMEs, docs folders,
  release pages and the search API for star counts), Anthropic's docs and pricing
  pages, and the open docs repositories of VS Code, GitHub and Warp, which count as
  **read**. The research environment blocked conductor.build, cursor.com,
  developers.openai.com, openai.com, emdash.sh, paradev.com, cmux.com, warp.dev,
  antigravity.google, jetbrains.com, orchestrator.inc, herdr.dev and the app
  stores, so facts from those sites are **snippet** unless marked otherwise.
- Each **Sources** line gives the month checked; prices and star counts are as of
  that month. Check prices directly before quoting them.

## Summary

- **Must be best:** PC is better than every scored app on price and on privacy,
  apart from ties on price with Emdash, Orchestrator and herdr, which are also free
  and open source. It is not yet best on the other four:
  - **Agent choice:** better than every vendor app, but Emdash (37 agent CLIs),
    Orchestrator (36), herdr (about 28), Paradev (21 plus any CLI), Warp (16) and
    cmux (14) detect more agents than PC's five built-in ones plus custom agents.
  - **Overview and attention:** slightly worse than Orchestrator, whose board
    lanes also follow PR, CI and review state (In review, Ready to merge). A tie
    with Conductor, Paradev, GitHub Copilot, cmux, Warp and herdr: jumping to the
    next waiting agent and a board by state are now common.
  - **Review:** better than Conductor, Emdash, Paradev and the terminals; a tie
    with the Codex app, Claude Code desktop and GitHub Copilot; mixed against
    Orchestrator's reviewer agent; worse than Cursor's PR review and Bugbot.
  - **Keyboard workflow:** a tie with nearly everyone. Almost every competitor has
    a command palette; PC has a task switcher.
- **Must not lose badly:** PC loses on phone and remote access to all four vendor
  apps and Orchestrator; on starting tasks to Emdash, Paradev and Cursor; on
  running and previewing to Paradev, Claude Code and Cursor; and on the PR flow to
  GitHub Copilot and Orchestrator, which send failing CI, review comments and
  conflicts back to the agent on their own. Most other losses are slight.
- **Won't compete, new evidence:**
  - **Cloud execution:** every vendor app, Conductor, Paradev, Orchestrator and
    cmux offer it, most of them with an official phone app; the last four shipped
    it in 2026.
  - **Windows:** every vendor app, Emdash, Orchestrator, Warp and herdr run on it.
- **Tracked, worth a look:** scheduled or event-triggered automations
  (Conductor, Emdash, Paradev, Orchestrator, Codex, Claude Code, Cursor, Copilot,
  Warp) and team features (Conductor, Paradev, every vendor app) became standard in 2026.
- **Market moves:**
  - Vibe Kanban's company shut down in April and its board is export-only.
  - Superset renamed itself Paradev on 2026-10-26 with an $11.5M seed.
  - Composio's agent-orchestrator moved to Orchestrator.inc and was renamed
    Orchestrator (v0.14.0, 10-14).
  - Conductor reportedly raised a $22M Series A in March, and herdr, which reached
    46k stars in seven months, a $6M seed (both snippet).
  - The Codex app became the Codex mode of the ChatGPT desktop app in July.

| Competitor     | Suits better than PC                                             | PC clearly better                             | PC worse where it must not lose badly ("slightly" in brackets)          |
| -------------- | ---------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| Conductor      | Mac users who want cloud workspaces, an iOS app or multiplayer   | Agent choice, planning, Linux, price, privacy | (Starting tasks, PR flow, first run)                                    |
| Emdash         | Linear, Jira or GitLab users; SSH remote projects; Windows       | Review                                        | Starting tasks; (PR flow, Linux packaging)                              |
| Paradev        | Teams; Mac users who want automations, cloud and an iOS app      | Linux, price, privacy (by far)                | Starting tasks, running and previewing; (PR flow)                       |
| Orchestrator   | Users who want the PR loop closed automatically and store apps   | Privacy                                       | PR flow, phone and remote; (Linux packaging)                            |
| Codex app      | OpenAI-only users who want cloud tasks and the ChatGPT phone app | Agent choice (by far), price, privacy         | Phone and remote; (running and previewing, first run)                   |
| Claude Code    | Claude-only users who want cloud sessions and PR auto-fix        | Agent choice, price, privacy (all by far)     | Phone and remote, running and previewing; (PR flow, first run)          |
| Cursor         | IDE users who want cloud agents and Bugbot                       | Agent choice, price, privacy (by far)         | Starting tasks, phone and remote, running; (first run, Linux packaging) |
| GitHub Copilot | GitHub-centred teams who want the PR loop automated              | Price, privacy                                | PR flow, phone and remote; (starting tasks, isolation, running)         |

## Parallel-agent apps

Verdicts are from PC's side; "Must not lose" means must not lose badly. Each app's
section below gives the reasons.

| #   | Dimension                  | Group         | Conductor       | Emdash          | Paradev         | Orchestrator   |
| --- | -------------------------- | ------------- | --------------- | --------------- | --------------- | -------------- |
| 1   | Agent choice               | Must be best  | Better          | Slightly worse  | Slightly worse  | Slightly worse |
| 2   | Isolation and setup        | Must not lose | Mixed           | Mixed           | Mixed           | Mixed          |
| 3   | Starting tasks             | Must not lose | Slightly worse  | Worse           | Worse           | Tie            |
| 4   | Overview and attention     | Must be best  | Tie             | Slightly better | Tie             | Slightly worse |
| 5   | Review                     | Must be best  | Slightly better | Better          | Slightly better | Mixed          |
| 6   | Merge and pull requests    | Must not lose | Slightly worse  | Slightly worse  | Slightly worse  | Worse          |
| 7   | Running and previewing     | Must not lose | Tie             | Tie             | Worse           | Tie            |
| 8   | Planning and orchestration | Tracked       | Better          | Mixed           | Mixed           | Mixed          |
| 9   | Integrations               | Tracked       | Slightly worse  | Worse           | Worse           | Slightly worse |
| 10  | Phone and remote           | Must not lose | Mixed           | Mixed           | Mixed           | Worse          |
| 11  | Cloud execution            | Won't compete | Worse, by far   | Tie             | Worse, by far   | Worse          |
| 12  | Platforms                  | Must not lose | Better          | Slightly worse  | Better          | Slightly worse |
| 13  | Price and licence          | Must be best  | Better          | Tie             | Better          | Tie            |
| 14  | Privacy and local          | Must be best  | Better          | Slightly better | Better, by far  | Better         |
| 15  | Speed and reliability      | Must not lose | —               | —               | —               | —              |
| 16  | First run                  | Must not lose | Slightly worse  | Tie             | Mixed           | Tie            |
| 17  | Keyboard workflow          | Must be best  | Tie             | Tie             | Tie             | Tie            |
| 18  | Team features              | Tracked       | Worse, by far   | Tie             | Worse, by far   | Slightly worse |
| 19  | Customization              | Tracked       | Slightly better | —               | Slightly worse  | Tie            |

### PC baseline (v5.1.0, read from code)

1. **Agent choice:**
   - Built in: Claude Code, Codex CLI, OpenCode, Copilot CLI and Antigravity CLI
     (`electron/ipc/agents.ts`); any other terminal agent under Settings → Agents →
     Custom agents.
   - Each runs as its own CLI with the user's own login and plan, side by side on
     one board. Agent env files supply credentials the login shell doesn't export.
   - Open requests: Kimi CLI ([#109]), different Claude accounts per task
     ([#244]), the agent's plan mode as a prompt-box control ([#256]), and the
     OrcaRouter model-routing provider ([#269]).
2. **Isolation and setup:**
   - A branch and a git worktree per task, with a per-project branch prefix.
     Root-level git-ignored files and folders picked per task under "Symlink into
     worktree" are linked in; `node_modules`, `.env` and agent folders are
     preselected (`getSymlinkCandidates` in `electron/ipc/git.ts`).
   - An optional Docker container per task ("Run in Docker container"), with the
     bundled image or the project's `.parallel-code/Dockerfile`; direct mode on the
     main checkout, folders without git, imported worktrees.
   - No setup, run or teardown script per worktree and no port allocation.
     Worktrees always live in `.worktrees/` ([#324]). Ignored files are only
     symlinked from the repository root and picked again for each task; nothing is
     copied, saved as a list or carried back on merge ([#231]).
3. **Starting tasks:**
   - New task dialog (`Ctrl+N`); images and files pasted into the agent's terminal.
   - GitHub issues and PRs browsed and started as tasks (`electron/github/`),
     project-plan cards, Super Productivity's "Start in Parallel Code", and agents
     creating tasks through MCP.
   - GitHub only ([#316]); no GitLab, Linear or Jira. Several tasks on the
     current branch ([#93]).
4. **Overview and attention:**
   - Board lanes by what each task needs (Needs you, Stopped, Working, In pull
     request, Snoozed); `Ctrl+Tab` to the next task waiting for you; tiles and
     focus layouts.
   - Claude Code's status comes from its hooks (`electron/agent-hooks/`); the
     other agents' from their terminal output (`src/store/taskStatus.ts`). Desktop
     notifications; opt-in per-turn task briefs.
5. **Review:**
   - Diff viewer with inline comments sent back to the agent, per-commit
     navigation, coverage badges.
   - Guided change tour and understanding tours with follow-up questions.
   - Confidence ratings from a separate reviewer model with read-only access;
     before-and-after screenshots; a project verify command and evidence checks.
   - No hunk staging or reverting, and no per-turn checkpoints.
6. **Merge and pull requests:**
   - Finish merges into the local base branch (merge or squash) or pushes the
     branch. There is no create-PR button; the agent or GitHub opens the PR.
   - For a GitHub PR: CI status watcher with notifications, merge (squash, merge,
     rebase), mark ready, and failed checks with log tails or unresolved review
     threads turned into a prompt for the agent.
   - Merge conflicts block the local merge and are listed file by file; the Finish
     dialog brings the base in by rebase or a merge commit, or asks the agent to
     rebase and resolve them.
7. **Running and previewing:** shell terminals per task, saved terminal commands
   per project, a browser preview pane with element picking for prompts.
8. **Planning and orchestration:** project plan as a Kanban board in `KANBAN.md`
   with "Plan with agent"; agents create and supervise child tasks through MCP;
   Arena runs one prompt on two to four agents; mind map and live reasoning graph.
   No scheduled or event-triggered runs.
9. **Integrations:** GitHub through `gh`; Super Productivity; an MCP server for
   agents; opens files in the configured editor. No Slack, Linear, Jira or GitLab.
10. **Phone and remote:**
    - QR pairing and a phone web UI over Wi-Fi or Tailscale that follows, answers
      and starts tasks. A sideloaded Android app (not in the Play Store) adds
      notifications, a widget, voice input, each task's diff and PR checks, a "Fix
      CI" prompt from failed checks, and several linked computers.
    - Web push for "needs input" needs HTTPS, for example Tailscale Serve.
      Terminal output and replies go straight between phone and computer; push
      carries only the task name and ID through the browser's push service.
    - No iOS app. No agents on remote or SSH machines. Telegram proposal ([#126]).
11. **Cloud execution:** none; agents run only on the user's computer.
12. **Platforms:** macOS universal `.dmg`, signed and notarized; Linux x64
    `.AppImage` and `.deb`. No Linux ARM64 or RPM. No Windows build; WSL users
    report it works with rough edges ([#9], closed).
13. **Price and licence:** free, MIT, no paid tier.
14. **Privacy and local:** no account, analytics, telemetry or crash reporting, and
    no server of its own ([PRIVACY.md](../../PRIVACY.md)).
15. **Speed and reliability:** tasks and layout persist across restarts. Open bugs:
    occasional terminal rendering issue ([#121]), copying from a Claude Code
    session ([#326]). Open request: restore tasks without resuming their agents
    ([#293]).
16. **First run:** a welcome screen shows which agent CLIs it found, or that it
    found none, links the first project and starts on the Board. Agents must be
    installed separately; [#213] asks for more guidance when none is installed.
17. **Keyboard workflow:** most actions have configurable shortcuts, with a
    Default and a Claude Code preset; `hjkl` and `Alt+Arrows` on the board; a task
    switcher (`Cmd+K` on macOS, `Ctrl+Shift+J` on Linux) but no command palette.
    Panel resizing is mouse-only and some click targets can't be reached by
    keyboard ([#210]).
18. **Team features:** none.
19. **Customization:** 16 built-in looks with separate dark and light picks that
    follow the system, custom themes, Focus, Tiles and Board layouts, configurable
    shortcuts. (The README and features.md still say 10 themes.)

### Unreleased on main

Merged after v5.1.0, up to `f49c16c` (2026-10-28):

- **Phone:** a more compact task composer, and scrolling full-screen agents one
  notch per three rows.
- **Android app** (ships with `android-v*` releases): terminal rows that no longer
  wrap on phones.

### Conductor

| #   | PC is           | Why                                                                                                                                                |
| --- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Better          | Bundles Claude Code, Codex and OpenCode, and reaches Cursor through its API; any other CLI only in the experimental Big Terminal Mode              |
| 2   | Mixed           | Conductor: setup, run and archive scripts, a block of 10 ports per workspace, a local secrets file. PC: ignored entries symlinked per task, Docker |
| 3   | Slightly worse  | GitHub issues, PRs and branches, plus Linear issues                                                                                                |
| 4   | Tie             | Sidebar states for needs input, permission and plan approval; ⌘⌥L jumps to the next workspace that needs you; a status matrix                      |
| 5   | Slightly better | Inline comments to the agent, an agent review guided by per-repo preferences, GitHub review threads in the app, per-turn checkpoints               |
| 6   | Slightly worse  | Create PR (⌘⇧P) with an agent-drafted description; a Checks tab treats CI, deployments, review comments and todos as merge blockers; merge in-app  |
| 7   | Tie             | Run tab and scripts, terminal, experimental in-app browser                                                                                         |
| 8   | Better          | Routines (cron or GitHub events, cloud only, paid), an API and MCP for workspaces; no plan board and no agent comparison                           |
| 9   | Slightly worse  | Linear and an API besides GitHub, MCP and open-in-editor                                                                                           |
| 10  | Mixed           | Native iOS app (Pro) since 10-02, experimental remote control of local Mac workspaces since 10-23; no Android                                      |
| 11  | Worse, by far   | Conductor Cloud microVMs keep running with the laptop closed                                                                                       |
| 12  | Better          | macOS only; Windows and Linux "not available yet"                                                                                                  |
| 13  | Better          | Free locally; Pro $50/mo, Teams $60/user/mo; closed source                                                                                         |
| 14  | Better          | PostHog analytics and crash logs; account for cloud and mobile                                                                                     |
| 16  | Slightly worse  | Agents come bundled; a setup check lists missing tools                                                                                             |
| 17  | Tie             | ⌘K command palette, ⌘/ shortcut list, rebindable shortcuts since 0.92.0                                                                            |
| 18  | Worse, by far   | Multiplayer workspaces with presence, reassigning work, Teams admin portal                                                                         |
| 19  | Slightly better | Light, dark and accessible themes; layered settings files                                                                                          |

- **Price:** Free (local workspaces, own subscriptions); Pro $50/mo (cloud, API,
  iOS app, multiplayer with up to five Pro users); Teams $60/user/mo; Enterprise.
  Cloud compute is free for now.
- **Traction:** $22M Series A led by Spark and Matrix (2026-03-30); YC S24;
  self-reported tenfold user growth from January to March (all snippet).
- **2026 releases:**
  - GitHub issues in the create dialog, Linear issues (Feb).
  - Command palette and jump to the next workspace needing attention (0.39.0).
  - Checks tab (07-16), background tasks, multiplayer early access and API (07-23),
    Conductor Cloud (07-30), Conductor MCP (08-20), routines (09-09).
  - iOS app (10-02); iOS remote control of local workspaces and rebindable
    shortcuts (0.92.0, 10-23).
- **Sources** (2026-10, snippet; conductor.build blocked):
  [pricing](https://conductor.build/pricing) ·
  [changelog](https://conductor.build/changelog) ·
  [docs](https://docs.conductor.build/) ·
  [Series A](https://thenewstack.io/conductor-cloud-ai-coding-agents/)

### Emdash

| #   | PC is           | Why                                                                                                                                          |
| --- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Slightly worse  | 37 agent CLIs in its registry, detected automatically, with hook-based status; PC has five plus custom agents                                |
| 2   | Mixed           | A pool of ready worktrees (task start under a second, snippet), setup, run and teardown scripts in `.emdash.json`, `.env*` kept, SSH remotes |
| 3   | Worse           | Tickets from Linear, GitHub, Jira, GitLab, Asana, YouTrack and four more; tasks from merge requests and branches                             |
| 4   | Slightly better | Kanban whose cards move by state, hook status, notifications, tray icon; no jump to the next waiting task                                    |
| 5   | Better          | Diff panel with staging, editing and comments sent to the agent; no AI review                                                                |
| 6   | Slightly worse  | Create PR, Checks tab, merge; a full GitLab merge-request flow, self-hosted included                                                         |
| 7   | Tie             | In-app browser, preview servers with port forwarding from remote hosts, terminals, run script                                                |
| 8   | Mixed           | Scheduled automations and best of N; no agent-spawned subtasks or plan board                                                                 |
| 9   | Worse           | Ten issue trackers, GitLab, Forgejo, MCP and skills management, open in many editors                                                         |
| 10  | Mixed           | No phone access; remote projects over SSH or Tailscale with a workspace server                                                               |
| 11  | Tie             | None; a cloud version for teams is on a waitlist                                                                                             |
| 12  | Slightly worse  | Linux x64 and ARM64 as AppImage, deb and RPM; also Windows                                                                                   |
| 13  | Tie             | Free, Apache-2.0                                                                                                                             |
| 14  | Slightly better | Local SQLite; PostHog telemetry on by default with an opt-out; optional sign-in                                                              |
| 16  | Tie             | Homebrew cask, agents detected automatically                                                                                                 |
| 17  | Tie             | Command palette (v1.2.0), keybinding overrides                                                                                               |
| 18  | Tie             | None shipped                                                                                                                                 |

- **Price:** free. "Emdash Cloud" for teams has no published price.
- **Traction:** 6.1k stars; YC W26; Show HN in February.
- **2026 releases:**
  - Show HN with 21 agents (02-24).
  - Zen mode and image paste (v1.1.40, 07-17).
  - Remote projects through a workspace server, file search, command palette, tray
    icon (v1.2.0, 08-28); Tailscale SSH (v1.2.2).
  - Usage page for Codex and Claude allowances, YouTrack, Jira (v1.2.8, 10-10).
  - GitLab repositories and merge requests (v1.2.9, 10-23).
- **Sources** (2026-10, read unless marked):
  [repository](https://github.com/generalaction/emdash) ·
  [releases](https://github.com/generalaction/emdash/releases) · agent registry
  and telemetry code in the repository · [docs](https://docs.emdash.sh/)
  (snippet; emdash.sh blocked)

### Paradev (formerly Superset)

| #   | PC is           | Why                                                                                                                                  |
| --- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Slightly worse  | 21 agents listed plus any CLI, custom agents with icons, per-agent model and effort, a built-in chat                                 |
| 2   | Mixed           | Setup, teardown and run scripts in `.superset/config.json`, ports detected per workspace, imported worktrees; no local sandbox       |
| 3   | Worse           | ⌘N, Linear, Slack messages, GitHub; a Tasks view; event-triggered automations (paid)                                                 |
| 4   | Tie             | Workspaces board by state (Needs attention, Working, Needs review, Idle, Merged), chimes, dock badges, every host in one list        |
| 5   | Slightly better | Diff viewer with comments and editing, PR diff lines sent to the agent, image diffs, Pages for team review; no independent AI review |
| 6   | Slightly worse  | Commit, push and open a PR from the Changes pane; a PR page with checks, timeline, ready for review and three merge methods          |
| 7   | Worse           | Terminal sessions in a daemon survive restarts and updates; browser with Design Mode; an iOS simulator and Android emulator pane     |
| 8   | Mixed           | MCP server, CLI, TypeScript SDK, subagents, automations; no plan board or head-to-head comparison                                    |
| 9   | Worse           | Linear, Slack, Sentry, Notion, Gmail, Vercel, Neon and PostHog plugins; open in five editors                                         |
| 10  | Mixed           | Native iOS and iPadOS app (Pro, iOS 26+), remote hosts through its relay or SSH; Android on a waitlist                               |
| 11  | Worse, by far   | Cloud workspaces (early access, paid)                                                                                                |
| 12  | Better          | macOS; the Linux AppImage is "experimental and untested"                                                                             |
| 13  | Better          | Free tier; Pro $20, Team $60, Ultra $200 per user per month; Elastic License 2.0, not open source                                    |
| 14  | Better, by far  | Sign-in required; PostHog analytics tied to the account; relay and cloud                                                             |
| 16  | Mixed           | Onboarding checklist that detects `gh` and agents, after creating an account                                                         |
| 17  | Tie             | Every action rebindable, command palette                                                                                             |
| 18  | Worse, by far   | Organizations, shared Pages with comments, presence, shared hosts                                                                    |
| 19  | Slightly worse  | Theme marketplace, 17 UI languages                                                                                                   |

- **Price:** Free (one user, local); Pro $20/user/mo, $16 yearly (remote access,
  automations, Linear and Slack, mobile); Team $60 (150 cloud hours per seat);
  Ultra $200 (500 cloud hours); Enterprise.
- **Traction:** 15.7k stars; $11.5M seed led by Union Square Ventures
  (2026-10-26); SOC 2 Type II.
- **Public comparison with PC:** Paradev's page "Paradev vs Parallel Code" (last
  updated 2026-10-20) lists PC's agents as Claude Code, Codex, Gemini CLI, Copilot
  CLI and Antigravity CLI (it has OpenCode, not Gemini CLI, plus custom agents),
  says PC has no programmatic control (agents create and supervise tasks through
  MCP) and cites v4.0.0 as the latest release. Its point that PC doesn't create
  PRs holds.
- **2026 releases:**
  - Mobile agents (03-30); 2.0 beta with remote hosts (04-27); automations, CLI and
    Slack bot (05-18).
  - Workspaces board (08-16); Design Mode and PR split view (08-23); commit, push
    and PR from the Changes pane (09-06); Pages (09-20).
  - Plugins and Tasks view (10-11); simulator and emulator pane, SSH hosts (10-18);
    paid plans (10-23); rename to Paradev and seed (10-26).
- **Sources** (2026-10, read unless marked):
  [repository](https://github.com/ParadevAI/Paradev) ·
  [releases](https://github.com/ParadevAI/Paradev/releases) · docs, changelog,
  privacy policy, pricing constants and comparison pages in the repository ·
  [pricing PR](https://github.com/superset-sh/superset/pull/8751) ·
  [pricing](https://superset.sh/pricing) (snippet; paradev.com blocked)

### Orchestrator (formerly agent-orchestrator)

| #   | PC is          | Why                                                                                                                                                                                                    |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Slightly worse | 36 agent harnesses, agent and model chosen per task, switching agents mid-session (v0.14.6), each on its own subscription                                                                              |
| 2   | Mixed          | Setup and cleanup scripts (`postCreate`, `preRemove`), symlinks such as `.env`, projects without git, cloud sandboxes; no Docker found                                                                 |
| 3   | Tie            | New task in the app, `ao spawn --issue`, GitHub and GitLab issue intake behind a flag, an orchestrator agent that spawns workers                                                                       |
| 4   | Slightly worse | Board lanes Working, Needs you, In review and Ready to merge, derived from agent, PR, CI and review state; dock badge; phone push                                                                      |
| 5   | Mixed          | A reviewer agent runs on each PR and posts inline GitHub comments; no inline comments of your own on the local diff                                                                                    |
| 6   | Worse          | Failing CI, review comments and merge conflicts go back to the worker on their own until the PR is approved; merge; GitHub and GitLab                                                                  |
| 7   | Tie            | A browser per worker with DevTools and annotations sent to chat; a terminal per session                                                                                                                |
| 8   | Mixed          | An orchestrator agent plans and spawns workers; recurring automations; no plan board or agent comparison                                                                                               |
| 9   | Slightly worse | GitHub and GitLab, self-managed included                                                                                                                                                               |
| 10  | Worse          | iOS and Android store apps paired by QR code: push, replies, approvals, starting workers, PR review, voice; over LAN, Tailscale or a Cloudflare tunnel. PC has no iOS app and a sideloaded Android one |
| 11  | Worse          | AO Cloud sandboxes keep working with the laptop closed (early preview, paid)                                                                                                                           |
| 12  | Slightly worse | Linux x64 as AppImage, deb and RPM; also Windows                                                                                                                                                       |
| 13  | Tie            | Free locally, Apache-2.0; AO Cloud is paid                                                                                                                                                             |
| 14  | Better         | PostHog telemetry on by default (installation ID and GitHub user name) with an opt-out; phone traffic can run through Cloudflare                                                                       |
| 16  | Tie            | Self-updating app with its daemon bundled; needs `gh` sign-in                                                                                                                                          |
| 17  | Tie            | Command palette; the whole app keyboard-navigable since v0.14.0                                                                                                                                        |
| 18  | Slightly worse | Shareable cloud sessions; Teams on a waitlist                                                                                                                                                          |
| 19  | Tie            | 20 themes and eight UI languages, against PC's 16 looks and custom themes                                                                                                                              |

- **History:** launched by Composio in February as an npm CLI with a web dashboard;
  the repository moved to Orchestrator.inc and v0.14.0 (10-14) renamed it.
  `github.com/ComposioHQ/agent-orchestrator` now serves the new repository.
- **Price:** free locally. AO Cloud plans of $20 and $40 a month appear only in an
  unmerged docs PR (unverified).
- **Traction:** 13.8k stars (about 7.5k in June); 340 issues opened in October.
- **2026 releases:** dock notifications, a reviewer agent per session and voice
  dictation on the phone (v0.12.0, about 08-05); rename, AO Cloud and 20 themes
  (v0.14.0, 10-14); switching agents mid-session (v0.14.6); shareable cloud
  sessions (v0.14.7, 10-28).
- **Sources** (2026-10, read unless marked):
  [repository](https://github.com/OrchestratorInc/agent-orchestrator), its docs
  folder and README ·
  [releases](https://github.com/OrchestratorInc/agent-orchestrator/releases) ·
  [docs PR with store links and prices](https://github.com/OrchestratorInc/agent-orchestrator/pull/6912)
  (unmerged) · orchestrator.inc (snippet; blocked)

## Vendor apps

| #   | Dimension                  | Group         | Codex app       | Claude Code     | Cursor          | GitHub Copilot  |
| --- | -------------------------- | ------------- | --------------- | --------------- | --------------- | --------------- |
| 1   | Agent choice               | Must be best  | Better, by far  | Better, by far  | Better          | Slightly better |
| 2   | Isolation and setup        | Must not lose | Mixed           | Mixed           | Mixed           | Slightly worse  |
| 3   | Starting tasks             | Must not lose | Mixed           | Mixed           | Worse           | Slightly worse  |
| 4   | Overview and attention     | Must be best  | Slightly better | Slightly better | Slightly better | Tie             |
| 5   | Review                     | Must be best  | Tie             | Tie             | Worse           | Tie             |
| 6   | Merge and pull requests    | Must not lose | Mixed           | Slightly worse  | Tie             | Worse           |
| 7   | Running and previewing     | Must not lose | Slightly worse  | Worse           | Worse           | Slightly worse  |
| 8   | Planning and orchestration | Tracked       | Mixed           | Mixed           | Mixed           | Slightly worse  |
| 9   | Integrations               | Tracked       | Worse           | Worse           | Worse           | Worse           |
| 10  | Phone and remote           | Must not lose | Worse           | Worse           | Worse           | Worse           |
| 11  | Cloud execution            | Won't compete | Worse, by far   | Worse, by far   | Worse, by far   | Worse, by far   |
| 12  | Platforms                  | Must not lose | Slightly better | Slightly better | Slightly worse  | Tie             |
| 13  | Price and licence          | Must be best  | Better          | Better, by far  | Better          | Better          |
| 14  | Privacy and local          | Must be best  | Better          | Better, by far  | Better, by far  | Better          |
| 15  | Speed and reliability      | Must not lose | —               | —               | —               | —               |
| 16  | First run                  | Must not lose | Slightly worse  | Slightly worse  | Slightly worse  | Tie             |
| 17  | Keyboard workflow          | Must be best  | Tie             | Slightly better | Tie             | Tie             |
| 18  | Team features              | Tracked       | Worse           | Worse           | Worse           | Worse           |
| 19  | Customization              | Tracked       | Tie             | —               | Worse           | Worse           |

The agents and services of all four are proprietary (VS Code itself is MIT), and
all four run on Windows too, which PC records under won't compete.

### Codex app (Codex mode of the ChatGPT desktop app)

| #   | PC is           | Why                                                                                                                                      |
| --- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Better, by far  | Only OpenAI's agent and models; other providers only through the CLI's configuration                                                     |
| 2   | Mixed           | Setup scripts per OS in `.codex/`, `.worktreeinclude` for ignored files, Actions (saved commands), handoff between checkout and worktree |
| 3   | Mixed           | `@codex` in GitHub, Linear, Slack and GitLab (beta), scheduled tasks, the phone; no issue browser in the app found                       |
| 4   | Slightly better | Activity view of unread, running and waiting threads, pins; no lanes or jump to the next                                                 |
| 5   | Tie             | Diffs of unstaged, staged, a commit, the branch or the last turn; inline comments; `/review` findings inline; stage or revert hunks      |
| 6   | Mixed           | Commit, push and create a PR in the app with a PR timeline; no CI view found                                                             |
| 7   | Slightly worse  | Terminal tabs, Actions for dev servers, built-in browser with comments on page elements, computer use on macOS and Windows               |
| 8   | Mixed           | Subagents and scheduled tasks; no board and no agent comparison                                                                          |
| 9   | Worse           | GitHub, GitLab (beta), Linear, Slack, MCP, a plugin catalogue, IDE and Chrome extensions                                                 |
| 10  | Worse           | The ChatGPT iOS and Android apps pair by QR code with the whole Mac or PC through OpenAI's relay; SSH hosts                              |
| 11  | Worse, by far   | Codex cloud                                                                                                                              |
| 12  | Slightly better | Linux is a preview (deb, rpm, x64 and ARM64)                                                                                             |
| 13  | Better          | In every ChatGPT plan with limits (Free and Go limited, Plus $20/mo)                                                                     |
| 14  | Better          | ChatGPT account or API key; remote control through OpenAI's relay                                                                        |
| 16  | Slightly worse  | Sign in and open a folder; the agent is built in                                                                                         |
| 17  | Tie             | Command menu, searchable and rebindable shortcuts                                                                                        |
| 18  | Worse           | Read-only shared thread snapshots, workspace admin                                                                                       |
| 19  | Tie             | Theme, accent and contrast settings                                                                                                      |

- **Price:** part of every ChatGPT plan: Free and Go ($8) limited, Plus $20/mo, Pro
  $100–500/mo, Business $20–25/user/mo.
- **Traction:** more than a million Mac downloads in the first week; more than five
  million weekly Codex users in June (snippet). The Codex CLI has 131.4k stars.
- **2026 releases:** macOS app (02-02), Windows (03-04), in-app browser and computer
  use (about 04-16), phone control of a Mac (05-14, generally available 06-25),
  merged into the ChatGPT desktop app on all plans (07-09), Linux preview (08-11),
  shared thread snapshots (Aug).
- **Sources** (2026-10, snippet unless marked; developers.openai.com and
  openai.com blocked): [Codex CLI](https://github.com/openai/codex) and its
  releases (read) · [app docs](https://developers.openai.com/codex/app) ·
  [remote connections](https://developers.openai.com/codex/remote-connections) ·
  [pricing](https://developers.openai.com/codex/pricing)

### Claude Code desktop

| #   | PC is           | Why                                                                                                                                                      |
| --- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Better, by far  | Claude only                                                                                                                                              |
| 2   | Mixed           | Worktree per session (off by default) in a configurable location, `.worktreeinclude`, local, SSH and cloud environments, cloud setup scripts, `autoPort` |
| 3   | Mixed           | Images and PDFs, suggested tasks with "Start all", Dispatch from the phone, scheduled tasks, Slack and GitHub; no issue browser                          |
| 4   | Slightly better | Sidebar grouped by status, project or environment; notifications; no jump to the next waiting session                                                    |
| 5   | Tie             | Inline diff comments to Claude, a `/code-review` card with "Fix this one", cloud Ultrareview, GitHub Code Review (Team, Enterprise)                      |
| 6   | Slightly worse  | Create PR, CI in the Changes card, auto-fix of failing CI and review comments, "Merge when ready", archive on merge; no local merge                      |
| 7   | Worse           | Terminal and file editor; a browser pane that starts dev servers from `.claude/launch.json` and checks them with screenshots and clicks; computer use    |
| 8   | Mixed           | Subagents, agent teams, `/batch` across 5–30 worktrees, Projects (beta); one vendor, no board                                                            |
| 9   | Worse           | MCP connectors, plugins, skills, GitHub App, Slack, Chrome                                                                                               |
| 10  | Worse           | Remote Control from the Claude iOS and Android apps with push, through Anthropic's servers; SSH sessions                                                 |
| 11  | Worse, by far   | Cloud sessions, teleport between cloud and terminal, cloud scheduled tasks                                                                               |
| 12  | Slightly better | The Linux desktop app is a beta (apt, deb)                                                                                                               |
| 13  | Better, by far  | Needs Pro ($20/mo, $17 yearly) or higher                                                                                                                 |
| 14  | Better, by far  | Account; usage metrics on by default with an opt-out; Remote Control and cloud keep transcripts on Anthropic's servers                                   |
| 16  | Slightly worse  | Bundles Claude Code; creates environments from recent folders                                                                                            |
| 17  | Slightly better | Shortcut list and many shortcuts; no rebinding found                                                                                                     |
| 18  | Worse           | Shared links to cloud sessions, organization admin                                                                                                       |

- **Price:** Pro $20/mo ($17 yearly), Max from $100/mo, Team from $20/seat,
  Enterprise.
- **2026 releases:** Remote Control preview (02-24), desktop redesign for parallel
  sessions with a status sidebar, panes, terminal and editor (04-14), Linux beta
  (06-30, snippet), Projects beta (09-17, snippet), Code Review levels (10-19).
- **Sources** (2026-10, read):
  [desktop](https://code.claude.com/docs/en/desktop) ·
  [Remote Control](https://code.claude.com/docs/en/remote-control) ·
  [on the web](https://code.claude.com/docs/en/claude-code-on-the-web) ·
  [data usage](https://code.claude.com/docs/en/data-usage) ·
  [changelog](https://code.claude.com/docs/en/changelog) ·
  [pricing](https://claude.com/pricing) ·
  [redesign post](https://claude.com/blog/claude-code-desktop-redesign)

### Cursor

| #   | PC is           | Why                                                                                                                                   |
| --- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Better          | Its own harness with many vendors' models, not their CLIs or subscriptions; the cheapest new plan reportedly only has Cursor's models |
| 2   | Mixed           | Worktrees with setup commands in `.cursor/worktrees.json`, cloud VMs with secrets, SSH, self-hosted machines                          |
| 3   | Worse           | Agents Window, web, iOS, Slack, Linear, GitHub comments, an API, Automations, `/multitask`                                            |
| 4   | Slightly better | Agents Window sidebar; iOS push and Live Activities; no lanes by what an agent needs                                                  |
| 5   | Worse           | PR review with inline threads, AI review in the editor, Bugbot with Autofix, Security Reviewer                                        |
| 6   | Tie             | Stage, commit and open PRs in the Agents Window; split PRs                                                                            |
| 7   | Worse           | Built-in browser with Design Mode; cloud agents with a remote desktop                                                                 |
| 8   | Mixed           | Best of N across models in worktrees with judging, `/multitask`, Automations; no board                                                |
| 9   | Worse           | GitHub, GitLab, Slack, Linear, PagerDuty, MCP, a plugin marketplace, VS Code extensions                                               |
| 10  | Worse           | iOS app (beta) and Remote Control of local agents, whose agent loop runs in Cursor's cloud; SSH                                       |
| 11  | Worse, by far   | Cloud Agents in VMs with handoff both ways                                                                                            |
| 12  | Slightly worse  | macOS and Linux (deb, RPM, AppImage, x64 and ARM64)                                                                                   |
| 13  | Better          | Free tier without cloud agents, paid plans $8–200/mo (snippet)                                                                        |
| 14  | Better, by far  | Account; Privacy Mode; the agent loop runs in Cursor's cloud even for Remote Control                                                  |
| 16  | Slightly worse  | One-click import of VS Code settings and extensions                                                                                   |
| 17  | Tie             | VS Code command palette and keybindings                                                                                               |
| 18  | Worse           | Shared agents, team rules, admin, SSO                                                                                                 |
| 19  | Worse           | VS Code themes and extensions, tiled layout                                                                                           |

- **Price:** new plans from 2026-10-12: Free, Plus $8, Premium $30, Super $100,
  Ultra $200 per month; legacy Pro $20; Bugbot billed per run (all snippet).
- **Traction:** SpaceX agreed to buy Anysphere, Cursor's maker, for $60B
  (2026-06-16, snippet).
- **2026 releases:** Automations (03-05), Cursor 3.0 Agents Window with local,
  worktree, cloud and SSH agents (04-02), PR review and Build in Parallel (05-07),
  iOS app and Remote Control of local agents (06-29), Remote Control on by default
  (10-06).
- **Sources** (2026-10, snippet; cursor.com blocked):
  [changelog](https://cursor.com/changelog) ·
  [Agents Window](https://cursor.com/docs/agent/agents-window) ·
  [worktrees](https://cursor.com/docs/configuration/worktrees) ·
  [pricing](https://cursor.com/pricing)

### GitHub Copilot (VS Code Agents window, Copilot app)

| #   | PC is           | Why                                                                                                                                        |
| --- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Slightly better | Copilot, Claude and Codex agents side by side; Claude through Copilot billing or an API key, not a Claude subscription; no other CLIs      |
| 2   | Slightly worse  | Worktree per session, ignored files copied by setting, Dev Container sessions, an OS sandbox; setup and archive scripts in the Copilot app |
| 3   | Slightly worse  | Attach issues and PRs, start from a PR, start in the background, automations, start from GitHub Mobile                                     |
| 4   | Tie             | Sessions list with status and change stats, grid, unread markers, an app badge counting sessions waiting for input or with failing CI      |
| 5   | Tie             | Changes view (branch, uncommitted, last turn), range comments sent as feedback, a critique by a second model in the Copilot app            |
| 6   | Worse           | Create PR with auto-merge; Agent Merge addresses reviews, fixes CI, resolves conflicts and merges or queues                                |
| 7   | Slightly worse  | Browser per session with "Add element to chat" and screenshots; the Copilot app detects running servers                                    |
| 8   | Slightly worse  | Compare Models runs 2–10 attempts across agent types with a judge (preview); subagents; no board                                           |
| 9   | Worse           | Native GitHub, MCP, Slack and Notion connectors (preview), a plugin marketplace                                                            |
| 10  | Worse           | Steer CLI, app and cloud sessions from GitHub Mobile; a browser Agents window through a tunnel; SSH and WSL hosts                          |
| 11  | Worse, by far   | Cloud sessions and cloud automations                                                                                                       |
| 12  | Tie             | macOS and Linux; also web                                                                                                                  |
| 13  | Better          | Free tier limited by AI credits; Pro $10, Pro+ $39, Max $100 per month                                                                     |
| 14  | Better          | GitHub sign-in; cloud memory on by default                                                                                                 |
| 16  | Tie             | Sign in; onboarding tours; picks repositories from recent GitHub activity                                                                  |
| 17  | Tie             | Command palette, rebindable keys                                                                                                           |
| 18  | Worse           | Business and Enterprise policies, shared automations                                                                                       |
| 19  | Worse           | Themes, extensions, session-group icons                                                                                                    |

- **Price:** AI credits: Free, Pro $10, Pro+ $39, Max $100 per month; Business
  $19 and Enterprise $39 per seat. The Copilot app also runs with your own model
  key.
- **2026 releases:** Claude and Codex next to Copilot in VS Code (1.109, 02-04),
  Agents window in Stable (1.120, 05-13), Copilot app generally available (06-17,
  snippet), Agent Merge (1.136, 09-02), Compare Models preview (1.143, 10-21),
  cloud sessions and automations from VS Code (1.144, 10-28).
- **Sources** (2026-10, read unless marked): VS Code release notes
  [1.109](https://github.com/microsoft/vscode-docs/blob/main/release-notes/v1_109.md)
  to
  [1.144](https://github.com/microsoft/vscode-docs/blob/main/release-notes/v1_144.md) ·
  [Agents window docs](https://github.com/microsoft/vscode-docs/tree/main/docs/agents) ·
  [Copilot plans](https://github.com/github/docs/blob/main/content/copilot/get-started/plans.md) ·
  [Copilot CLI changelog](https://github.com/github/copilot-cli/blob/main/changelog.md) ·
  [Copilot app announcement](https://github.blog/changelog/2026-06-17-github-copilot-app-generally-available)
  (snippet)

## Terminal tools

Scored on the must-be-best dimensions plus isolation and setup.

| #   | Dimension              | Group         | cmux            | Warp            | herdr          |
| --- | ---------------------- | ------------- | --------------- | --------------- | -------------- |
| 1   | Agent choice           | Must be best  | Tie             | Tie             | Slightly worse |
| 2   | Isolation and setup    | Must not lose | Mixed           | Better          | Better         |
| 4   | Overview and attention | Must be best  | Tie             | Tie             | Tie            |
| 5   | Review                 | Must be best  | Better          | Slightly better | Better, by far |
| 13  | Price and licence      | Must be best  | Slightly better | Slightly better | Tie            |
| 14  | Privacy and local      | Must be best  | Better          | Better          | —              |
| 17  | Keyboard workflow      | Must be best  | Tie             | Tie             | Tie            |

### cmux

A native macOS terminal for coding agents built on libghostty (GPL-3.0 app; server
parts BSL). v0.65.2.2 (2026-10-27), 28.6k stars since January 2026, YC.

| #   | PC is           | Why                                                                                                                       |
| --- | --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | Tie             | Any terminal agent; hook-based status and resume for about 14 agents; Claude Code and Codex team modes                    |
| 2   | Mixed           | Follows `claude --worktree` and seeds worktrees from `.worktreeinclude`, but no managed worktree per task; SSH, cloud VMs |
| 4   | Tie             | Notification rings on panes, ⌘⇧U to the latest unread, a sidebar with branch, PR, ports and Running / Needs input / Idle  |
| 5   | Better          | A diff viewer whose line comments go to the agent; no AI review                                                           |
| 13  | Slightly better | The app is free; cloud VMs, the iOS app and a model gateway are paid                                                      |
| 14  | Better          | Sentry crash reports and analytics with an opt-out; local use needs no account                                            |
| 17  | Tie             | Rebindable shortcuts, command palette, keymap presets                                                                     |

- **Beyond the scored dimensions:** macOS only; an iOS app in beta with end-to-end
  encrypted push and replies; cmux Cloud (beta) and moving sessions between the Mac
  and SSH hosts (0.65.0, 10-05); a scriptable in-app browser.
- **Sources** (2026-10, read unless marked):
  [repository](https://github.com/manaflow-ai/cmux) and its CHANGELOG ·
  [releases](https://github.com/manaflow-ai/cmux/releases) ·
  [pricing](https://cmux.com/pricing) (snippet; cmux.com blocked)

### Warp

A terminal with its own agent that also runs other agent CLIs; open source
(AGPL-3.0) since 2026-04-27. v0.2026.10.21 (2026-10-22), 65.7k stars.

| #   | PC is           | Why                                                                                                                 |
| --- | --------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | Tie             | Warp Agent plus 16 detected CLI agents, each on the user's own subscription; notifications only for three of them   |
| 2   | Better          | Worktrees made by hand or through tab configs; no linked ignored folders or local containers                        |
| 4   | Tie             | Vertical tabs with agent, branch and active, waiting or idle status; a notification mailbox; click to jump          |
| 5   | Slightly better | A Code Review panel with hunk revert and inline comments sent to any supported agent; no AI review, by design       |
| 13  | Slightly better | Free with your own CLIs; the Warp Agent needs Build ($20/mo, snippet) or higher                                     |
| 14  | Better          | Login optional for most features, but telemetry must be on to use AI on the free plan; Remote Control uploads state |
| 17  | Tie             | Command palette and shortcuts                                                                                       |

- **Beyond the scored dimensions:** macOS, Windows and Linux; Remote Control turns
  any CLI agent session into a link to watch or steer from a phone browser; cloud
  agents (Oz) and Factories, triggered from Slack, Linear, GitHub Actions or a
  schedule; team session sharing.
- **Sources** (2026-10, read unless marked):
  [repository](https://github.com/warpdotdev/warp) ·
  [docs repository](https://github.com/warpdotdev/docs): CLI agents, Remote Control,
  code review, worktrees, privacy, plans and 2026 changelog ·
  [pricing analysis](https://capitalandcompute.net/blog/warp-pricing-explained/)
  (snippet)

### herdr

A terminal multiplexer for coding agents: one Rust binary that runs inside your
terminal, like tmux, and marks each pane working, blocked, idle or done.
Apache-2.0 (AGPL until 0.8.0). v0.9.5 (2026-10-14), 46.3k stars since its first
release on 2026-03-27, with 2,700 issues and 600 merged PRs from many authors.

| #   | PC is          | Why                                                                                                              |
| --- | -------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | Slightly worse | About 28 agents detected, five more report their own state, anything else as a plain terminal; own subscriptions |
| 2   | Better         | `herdr worktree` creates, opens and removes worktrees; no setup scripts, containers or linked ignored files      |
| 4   | Tie            | State rolled up per pane, tab and workspace; sounds and OS notifications; a picker filtered by state; next agent |
| 5   | Better, by far | No diff viewer and no review                                                                                     |
| 13  | Tie            | Free, Apache-2.0                                                                                                 |
| 14  | —              | No account; telemetry not documented, so not scored                                                              |
| 17  | Tie            | tmux-style prefix keys, everything rebindable, a Go To navigator                                                 |

- **Beyond the scored dimensions:** macOS, Linux and Windows; sessions survive the
  client closing and SSH drops; several SSH machines in one window (0.9.0, 09-07),
  usable from a phone's SSH client; agents start, prompt and wait for each other
  through a CLI and socket API. A $6M seed led by Bessemer (September, snippet).
- **Sources** (2026-10, read unless marked):
  [repository](https://github.com/herdrdev/herdr), its CHANGELOG and website docs
  folder · [releases](https://github.com/herdrdev/herdr/releases) · funding
  (snippet; herdr.dev blocked)

## Cloud agents (not scored)

Context for the won't-compete dimension: agents that keep working while the laptop
is off.

| Product                | Entry price                    | Phone app            |
| ---------------------- | ------------------------------ | -------------------- |
| Codex cloud            | ChatGPT Plus $20/mo (snippet)  | ChatGPT app          |
| Claude Code on the web | Claude Pro $20/mo (read)       | Claude app (read)    |
| Cursor cloud agents    | Paid plans; tier unclear       | iOS beta (snippet)   |
| Copilot cloud agent    | Copilot Pro $10/mo (read)      | GitHub Mobile (read) |
| Google Jules           | Free, 15 tasks a day (snippet) | None found           |
| Devin                  | Free, then $20/mo (snippet)    | None found           |

## Watch list

Not scored. Each refresh checks status only and proposes moving an app into the
set when it gains traction or changes category.

| App                       | Status (2026-10)                                                                                                                    | Why it is watched                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Vibe Kanban               | Company shut down 2026-04-10; board export-only since v0.1.44; community releases since September; 28.5k stars                      | Was the most-starred open-source rival                       |
| JetBrains Air             | Public preview since March; macOS and Windows, Linux unconfirmed; Claude Agent, Codex, Gemini CLI, Junie and ACP agents             | Closest vendor match on agent choice; score once readable    |
| Google Antigravity 2.0    | Agent-first desktop app since 05-19; Google's agent only; Remote Control (08-21)                                                    | Vendor app; PC runs its CLI                                  |
| Xum (formerly Mux, Coder) | Renamed after a trademark complaint; v0.32.1; own agent loop with API keys; 2.1k stars                                              | Strong remote runtimes (SSH, Docker, Daytona)                |
| Nimbalyst (was Crystal)   | Crystal deprecated in February; Nimbalyst v0.81.7, MIT, 2k stars, iOS app                                                           | Session kanban, visual documents                             |
| Claude Squad              | v1.0.20 (08-20), no commits since; 8.7k stars                                                                                       | Terminal baseline, slowing                                   |
| Sculptor (Imbue)          | Research preview, v0.49.0; 241 stars                                                                                                | Container isolation                                          |
| Happy                     | MIT, 24.4k stars; iOS and Android store apps plus a desktop app for Claude Code, Codex and other agents; end-to-end encrypted relay | Phone access from anywhere; competes with PC on dimension 10 |

## Gaps

Gaps where PC misses its group's bar, roughly in order of how many competitors are
ahead. A row is a prompt, not a plan. Status values are defined in
[README.md](README.md#monthly-refresh) (step 4).

| Gap                                                                                                   | #    | Who has it                                                                      | Issue               | Status (2026-10) |
| ----------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------- | ------------------- | ---------------- |
| Native phone apps with push, iOS included; easier push setup than HTTPS                               | 10   | Codex, Claude Code, Cursor, Copilot, Orchestrator, Conductor, Paradev, cmux     | [#192] (push setup) | —                |
| Agents on remote or SSH machines                                                                      | 10   | Codex, Claude Code, Cursor, Copilot, Emdash, Paradev, Orchestrator, cmux, herdr | none                | —                |
| Create a PR from the app, with a drafted description                                                  | 6    | Conductor, Emdash, Paradev, Orchestrator, Codex, Claude Code, Cursor, Copilot   | none                | —                |
| Auto-fix failing CI and review comments; merge when ready                                             | 6    | Orchestrator, Claude Code, Copilot (Agent Merge), Cursor (Bugbot Autofix)       | none                | —                |
| Issues from Linear, Jira and GitLab; non-GitHub repositories                                          | 3    | Emdash, Paradev, Conductor (Linear), Codex, Cursor                              | [#316]              | —                |
| Setup, run and teardown scripts per worktree; a port block per worktree                               | 2, 7 | Conductor, Emdash, Paradev, Orchestrator, Codex, Claude Code, Cursor, Copilot   | [#231], [#324]      | —                |
| Agent-driven browser checks (screenshots, clicks) and persistent terminals                            | 7    | Claude Code, Cursor, Paradev, Codex, Copilot                                    | none                | —                |
| Command palette                                                                                       | 17   | Conductor, Emdash, Paradev, Orchestrator, Codex, Cursor, Copilot, cmux, Warp    | none                | —                |
| More built-in agents (Amp, Cursor CLI, Droid, Kimi) and hook-based status beyond Claude Code          | 1    | Emdash, Orchestrator, herdr, Paradev, Warp, cmux                                | [#109]              | —                |
| Board lanes that follow PR, CI and review state; a badge for waiting agents                           | 4    | Orchestrator; ties: Conductor, Paradev, Copilot, cmux, Warp, herdr              | none                | —                |
| Review: PR review in the app, a reviewer agent on each PR, cloud and GitHub code review, hunk staging | 5    | Cursor; Orchestrator (mixed); ties: Codex, Claude Code, Copilot                 | none                | —                |
| Agents installed with the app, or installed from the welcome screen                                   | 16   | Conductor, Codex, Claude Code, Cursor                                           | [#213]              | —                |
| Linux ARM64 and RPM builds                                                                            | 12   | Emdash, Orchestrator (RPM), Codex, Cursor                                       | none                | —                |

## Speed benchmark

Not measured yet. The jobs are defined in [README.md](README.md#speed-benchmark).

[#9]: https://github.com/johannesjo/parallel-code/issues/9
[#93]: https://github.com/johannesjo/parallel-code/issues/93
[#109]: https://github.com/johannesjo/parallel-code/issues/109
[#121]: https://github.com/johannesjo/parallel-code/issues/121
[#126]: https://github.com/johannesjo/parallel-code/issues/126
[#192]: https://github.com/johannesjo/parallel-code/issues/192
[#210]: https://github.com/johannesjo/parallel-code/issues/210
[#213]: https://github.com/johannesjo/parallel-code/issues/213
[#231]: https://github.com/johannesjo/parallel-code/issues/231
[#244]: https://github.com/johannesjo/parallel-code/issues/244
[#256]: https://github.com/johannesjo/parallel-code/issues/256
[#269]: https://github.com/johannesjo/parallel-code/issues/269
[#293]: https://github.com/johannesjo/parallel-code/issues/293
[#316]: https://github.com/johannesjo/parallel-code/issues/316
[#324]: https://github.com/johannesjo/parallel-code/issues/324
[#326]: https://github.com/johannesjo/parallel-code/issues/326
