# Market position

Where Parallel Code has to be the best app on the market, which apps we measure
against, and how the comparison is kept current. The data lives in
[scorecard.md](scorecard.md); this page holds the target and the method.

Only the maintainer changes this page. The monthly refresh edits only the
scorecard and proposes changes to this page in its PR description.

The guidance in [AGENTS.md](../../AGENTS.md) and the positioning in the
[README](../../README.md#why-parallel-code) rank above this page and the scorecard.
A dimension where PC loses is a prompt to look, not an instruction to build. Every
gap still has to be worth its weight: the core loop (start a task, review its
diff, merge or discard it) stays simple, and everything else stays out of the way
until someone uses it.

## Target

**The best app for one developer running several coding agents at once on their
own computer: start tasks quickly, see which agent needs you, review the work and
merge what's good, with any agent CLI, free and local.**

"Best" is judged per group, not across every feature:

| Group                   | Meaning                                                                                                                                                                                                                           | Dimensions                                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Must be best**        | Better than every scored app. These are the main promises of the README's "Why Parallel Code?" and "Where it fits"; isolation and phone access, which it also claims, sit one group lower because most competitors now match them | Agent choice · Overview and attention · Review · Keyboard workflow · Price and licence · Privacy and local                                                 |
| **Must not lose badly** | Close to the best app, because users who give up here never reach the strengths above                                                                                                                                             | Isolation and setup · Starting tasks · Merge and pull requests · Running and previewing · Phone and remote · Platforms · Speed and reliability · First run |
| **Won't compete**       | A recorded decision; the refresh only reports new evidence against it                                                                                                                                                             | Cloud execution (README: not for agents that keep working while the laptop is off) · Windows (AGENTS.md: macOS and Linux only)                             |
| **Tracked**             | Recorded for context, no target                                                                                                                                                                                                   | Planning and orchestration · Integrations · Team features · Customization                                                                                  |

## Competitor set

Keep the set fixed between refreshes so results stay comparable; change it only
here. There are five groups, one scorecard section each:

- **Parallel-agent apps**, scored on every dimension: apps built for exactly
  PC's job, and the closest alternatives for someone who already wants it.
  Conductor, Emdash, Paradev (formerly Superset), Orchestrator (formerly
  Composio's agent-orchestrator).
- **Vendor apps**, scored on every dimension: what most people use instead of PC,
  because it comes with the agent or the editor they already pay for. The Codex
  app (the Codex mode of the ChatGPT desktop app), Claude Code desktop, Cursor, and
  GitHub Copilot (VS Code's Agents window and the Copilot app).
- **Terminal tools**, scored on the must-be-best dimensions plus Isolation and
  setup: what keyboard-heavy users use instead of a GUI. cmux, Warp, herdr.
- **Cloud agents**, not scored: context for the won't-compete Cloud execution
  dimension. Codex cloud, Claude Code on the web, Cursor cloud agents, Copilot
  cloud agent, Jules, Devin.
- **Watch list**, not scored: apps that shut down, are in preview, or sit just
  outside PC's job. The refresh checks their status only and proposes moving one
  into the set. Vibe Kanban, JetBrains Air, Google Antigravity, Xum, Nimbalyst,
  Claude Squad, Sculptor, Happy.

## Dimensions

| #   | Dimension                  | Group               | What is compared                                                                                 |
| --- | -------------------------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | Agent choice               | Must be best        | Which agent CLIs and models, vendors side by side, custom agents, own subscription or bundled    |
| 2   | Isolation and setup        | Must not lose badly | Worktrees, setup and teardown scripts, env and ignored files, containers and sandboxes, ports    |
| 3   | Starting tasks             | Must not lose badly | New-task speed, from issues (GitHub, GitLab, Linear, Jira), templates, attachments, many at once |
| 4   | Overview and attention     | Must be best        | All agents at a glance, which one needs you, notifications, status detection, jump to the next   |
| 5   | Review                     | Must be best        | Diff viewer, inline comments back to the agent, explanations, independent AI review              |
| 6   | Merge and pull requests    | Must not lose badly | Local merge, push, PR creation, CI status, conflicts, rebase, cleanup                            |
| 7   | Running and previewing     | Must not lose badly | Run scripts, dev servers, built-in browser preview, terminals per task                           |
| 8   | Planning and orchestration | Tracked             | Planning boards, agent-spawned subtasks, comparing agents on one task, dependencies              |
| 9   | Integrations               | Tracked             | Issue trackers, Slack, MCP, task managers, opening the worktree in an editor                     |
| 10  | Phone and remote           | Must not lose badly | Following and answering agents from a phone, agents on remote or SSH machines                    |
| 11  | Cloud execution            | Won't compete       | Agents that keep working with the laptop off, cloud sandboxes, hand-off between local and cloud  |
| 12  | Platforms                  | Must not lose badly | macOS and Linux packaging and quality; Windows is recorded under won't compete                   |
| 13  | Price and licence          | Must be best        | Free tier, paid plans, platform fees, open-source licence                                        |
| 14  | Privacy and local          | Must be best        | Account requirement, telemetry, where code and prompts go, servers of its own                    |
| 15  | Speed and reliability      | Must not lose badly | Many agents at once, resource use, crash and lost-work reports, state surviving restarts         |
| 16  | First run                  | Must not lose badly | Download to first task, agent detection, learning curve                                          |
| 17  | Keyboard workflow          | Must be best        | Shortcut coverage, command palette, keyboard navigation between agents                           |
| 18  | Team features              | Tracked             | Shared sessions, team workspaces, shared settings                                                |
| 19  | Customization              | Tracked             | Themes, layouts, settings                                                                        |

Each scorecard cell is written from PC's side: **Better**, **Tie**, **Worse** or
**Mixed** (it depends on platform or use), optionally narrowed with "slightly",
"by far" or a scope such as "on Linux". **—** means not scored. Each competitor
section ends with a **Sources** line that gives the month checked and a
confidence; a fact that differs says so inline:

- **read**: the vendor page, docs, changelog, repository or our code was read
  directly
- **snippet**: only a search-result excerpt was available, for example because the
  host was blocked
- **unverified**: a single weak or conflicting source

Never raise a confidence level without reading the source directly. Score PC on
its latest release and list unreleased changes on `main` separately. After
`git fetch --tags`, the latest release is
`git tag --list 'v[0-9]*' --sort=-v:refname | grep -v -- - | head -1` (the
pattern skips the `android-v*` tags, and the `grep` drops pre-release tags).

## Speed benchmark

Feature lists hide how fast a job gets done. Each job counts clicks or
keystrokes, plus seconds, from the stated start to the stated end:

| Job                   | Start → end                                                               | Where   |
| --------------------- | ------------------------------------------------------------------------- | ------- |
| Start a task          | App open on a project → agent working on a typed prompt in a new worktree | Desktop |
| Task from an issue    | GitHub issue → agent working on it in a new worktree                      | Desktop |
| Answer the next agent | Two agents waiting for input → both answered                              | Desktop |
| Send review feedback  | Agent done → two inline comments on its diff sent back to it              | Desktop |
| Merge and clean up    | Reviewed task → merged into `main` and its worktree removed               | Desktop |
| Ten at once           | Ten prompts → ten agents working; record memory use after five minutes    | Desktop |
| Answer from the phone | "Needs input" notification on the phone → reply sent                      | Phone   |
| First run             | Download → first task merged, with one agent CLI already installed        | Desktop |

Every job is measured by hand, competitors' too. Re-measure a competitor's job
when its changelog says the job changed.

## Monthly refresh

A scheduled Claude Code session runs this procedure early each month. It edits
only `scorecard.md`, never this page. It stops without changes if the snapshot
line already names the current month, or if the `main` commit it names is less
than three weeks old.

The snapshot line under the scorecard's title names the month, the latest PC
release and the `main` commit that was read. It is the starting point of the
next run.

1. **Read** this page, [scorecard.md](scorecard.md), AGENTS.md, the README and
   [features.md](../features.md).
2. **PC side.**
   - If `git rev-parse --is-shallow-repository` prints `true`, run
     `git fetch --unshallow --tags`; otherwise `git fetch --tags`.
   - List the changes since the snapshot with
     `git log --oneline <snapshot commit>..origin/main`. If
     `git merge-base --is-ancestor <snapshot commit> origin/main` fails because
     history was rewritten, use `git log --oneline --since=<snapshot date> origin/main`
     instead. The desktop releases among the changes are
     `git tag --contains <snapshot commit> --list 'v[0-9]*' | grep -v -- -`.
   - Re-check every dimension those changes touch against the code. Released
     changes go into the PC baseline, the rest under "Unreleased on main". If a
     new release contains the snapshot commit, everything already listed under
     "Unreleased on main" has shipped too: move it into the baseline. Changes to
     the Android app (under `android/`) ship with `android-v*` tags instead; list
     them as Android app items and move them when such a tag contains them. Don't
     carry a PC fact forward from memory.
3. **Competitor side.** For each app, read its changelog or release notes, pricing
   page, docs and, for open-source apps, its repository (stars and releases) for
   changes since the snapshot. Run subagents in parallel: one for PC and one per
   competitor group (parallel-agent apps, vendor apps, and terminal tools together
   with cloud agents and the watch list). The parallel-agent subagent also looks
   for new apps for running coding agents in parallel that gained real traction
   since the snapshot; list them as proposed additions in the PR description,
   never add them to the set. If a host is blocked, use search snippets, mark them
   **snippet** and name the host in the PR. Never fill a number from memory.
   - Vendor sites are often blocked in the research environment. GitHub pages,
     `raw.githubusercontent.com` (READMEs, docs folders, changelogs, Homebrew
     casks) and the GitHub search API
     (`api.github.com/search/repositories?q=repo:OWNER/NAME`, for stars) usually
     work. The open docs repositories of VS Code (`microsoft/vscode-docs`), GitHub
     (`github/docs`) and Warp (`warpdotdev/docs`) count as **read**.
4. **Update the scorecard.**
   - Change only the cells and facts that moved. Set the month on the Sources
     line of each section you re-checked.
   - Keep the summary and the gap list in step with the tables.
   - The gap list has one row per gap where PC misses its group's bar: not better
     on a must-be-best dimension, or worse (slightly worse included) on a
     must-not-lose-badly one. Mixed counts as not better, but on a
     must-not-lose-badly dimension it is not a gap by itself. A tie at the ceiling
     on price (free with an OSI licence) or privacy (no account, telemetry or
     server of its own) is not a gap.
   - Each row links its open issues or says "none". Write issue and PR numbers as
     reference links (`[#123]`) and keep the link definitions at the end of the
     scorecard in step; bare `#123` doesn't link in a repository file. For a gap
     without an issue, search closed issues first (a declined idea needs new
     evidence), then list it under "proposed issues" in the PR description. Don't
     create issues.
   - A row's status is the furthest step its work has reached, with the link:
     **—** (no work yet), **Proposal** (a plan or design doc), **PR open**, **On
     main** (merged, not released) or **Released vX.Y.Z**. Prefix "Partly" when
     the work covers only part of the row. Re-check every linked issue and PR.
     Once a release closes a gap, re-score the dimension and remove the row.
   - Update the snapshot line, the version in the "PC baseline" heading and the
     "Merged after" line under "Unreleased on main".
5. **Public claims.** Compare the README's "Why Parallel Code?" and "Where it
   fits" sections, and [parallelcode.app](https://parallelcode.app) if reachable,
   against the scorecard and list contradictions in the PR description.
6. **Format and open the PR.** Run `npm ci` so Prettier and the git hooks use the
   pinned versions, then `npx prettier --write docs/market/scorecard.md`, then
   open one PR against
   `main` titled `docs(market): scorecard refresh YYYY-MM`. Its description lists:
   - verdict changes
   - notable competitor releases and price changes
   - gaps opened, moved or closed
   - proposed issues
   - proposed additions to the competitor set
   - proposed changes to this page
   - sources that were blocked
   - speed-benchmark jobs to re-measure

   If nothing but the months would change, open no PR and end with a short
   summary.

**Maintainer review of each refresh PR:**

- Merge it, or correct the verdicts.
- Pick at most three gaps to look into next; each still has to be worth its
  weight.
- Decide whether the target or the competitor set should change, and edit this
  page if so.
