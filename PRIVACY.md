# Privacy Policy

_Last updated: 2026-05-26_

Parallel Code is an open-source desktop application that runs entirely on your local machine. This policy describes what data the application handles and how.

## Summary

**The Parallel Code project operates no remote servers and does not collect, transmit, or store your data on any infrastructure we control.**

- No analytics
- No telemetry
- No crash reporting
- No usage tracking
- No account, sign-up, or login
- No remote logging
- No advertising or third-party trackers

## What data Parallel Code handles

Except where explicitly disclosed in the "Network activity initiated by Parallel Code itself" section below, data Parallel Code handles stays on your computer:

- **Your source code, git repositories, and worktrees** — read and written locally on your filesystem.
- **Task metadata, notes, prompts, settings, and UI state** — stored locally in the application's data directory.
- **Terminal sessions and shell output** — buffered locally for display and not sent to any infrastructure the project controls. Two local exceptions apply:
  - When you enable **Remote Access** (described under _Network activity_ below), the local server streams recent terminal output to authenticated clients that can reach the local listener — devices on your LAN, or devices that can reach a Tailscale-like address shown by the app.
  - If you use **Arena**, per-match terminal output is persisted to `arena-history.json` in the app's data directory until you delete it.

## Third-party AI coding CLIs

Parallel Code is a local interface for third-party AI coding CLIs and agent commands that you install and configure yourself, including:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (Anthropic)
- [Codex CLI](https://github.com/openai/codex) (OpenAI)
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) (Google)
- [Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli) (GitHub)
- [OpenCode](https://opencode.ai/) (a multi-provider AI coding agent)
- Arena presets such as Aider and any custom agent commands you add yourself

When you dispatch an agent, Parallel Code starts the selected CLI or command as a local subprocess on your machine, or inside a local Docker container when Docker mode is enabled. **That tool may then communicate with whatever vendor, model provider, repository host, package registry, or other service it is configured to use, under that service's own privacy policy and terms.** Parallel Code is not a party to those network communications and does not proxy them through infrastructure operated by the Parallel Code project.

**You are responsible for reviewing the privacy policy and terms of each third-party tool you choose to use.** Data sent to those services — including prompts, source code, and conversation history — is governed by their policies, not this one.

For sub-tasks run under a coordinator, Parallel Code prepends a short Parallel-Code-authored system-prompt preamble to the agent's first turn (for example, instructing the sub-task to call the `signal_done` MCP tool when finished). For Claude Code specifically, this preamble is injected by writing an entry into `.claude/settings.local.json` in the worktree; other agents receive the preamble through their own mechanism. The CLI then sends that preamble to its vendor alongside your prompt.

## Network activity initiated by Parallel Code itself

Unlike the AI CLIs above, the following network activity is initiated by Parallel Code itself, either directly or by invoking local tooling on your machine:

- **Application updates** — on packaged macOS and Linux AppImage builds, Parallel Code asks GitHub Releases whether a newer version exists about ten seconds after launch (and again if you click "Check for updates" in the UI). The request goes to the public GitHub Releases endpoint. In addition to your IP address, the underlying update library ([`electron-updater`](https://www.electron.build/auto-update)) sends two pieces of metadata that GitHub can see: a `User-Agent` header with the literal value `electron-builder`, and an `x-user-staging-id` header containing a random UUID generated locally on first launch and stored as `.updaterId` in the app's data directory. **This is a stable per-install identifier sent to GitHub on every update check** — GitHub can correlate the timing, frequency, and IP of those checks per install under its own policies. The Parallel Code project itself does not receive or store it. If you want a fresh identifier, delete `.updaterId`; the next check will generate a new UUID. Downloading an update only happens when you confirm it; once downloaded, the update is applied automatically the next time you quit the app.
- **GitHub PR status** — when a task is linked to a GitHub pull request, Parallel Code invokes your locally installed `gh` CLI to fetch the PR's state and check status. While the app window is visible, pending PRs are polled roughly every 30 seconds and already-settled PRs every five minutes. The `gh` CLI then contacts GitHub under your own existing authentication.
- **Other git operations** — `push`, `pull`, and `fetch` run only when you explicitly invoke them, using your local `git` tooling and its credentials. One implicit exception: when the app needs to know your repository's default branch and the cached remote-tracking ref is stale, it runs `git remote set-head origin --auto`, which contacts your configured remote.
- **Docker image builds** — when you click "Build Image" for Docker mode, Parallel Code invokes your local `docker` CLI / Docker daemon to run `docker build`. The bundled Dockerfile can contact Docker registries, Ubuntu package mirrors, NodeSource, GitHub CLI package repositories, and npm while building the image. If your project contains `.parallel-code/Dockerfile`, Parallel Code can build that Dockerfile instead using the project root as the Docker build context; if your Docker CLI is configured to use a remote Docker daemon or remote context, Docker may send that build context to that daemon according to your Docker configuration.
- **Inline code Q&A** — by default, the inline Q&A feature uses the Claude Code CLI as a local subprocess. The prompt sent to that CLI includes your question, a fixed instruction, and the selection you asked about — either a code snippet with file path and line range, or a markdown snippet from the in-app plan viewer with its source heading and an approximate position within the document. When you enable the optional [MiniMax](https://www.minimax.io/) provider in Settings, MiniMax is called directly by Parallel Code rather than as a subprocess: Parallel Code itself makes an HTTPS request to `api.minimax.io` using your API key, with the same kind of selected context in the request body. Your MiniMax API key is held in the main process in memory only and is not written to disk. Data sent to MiniMax is governed by MiniMax's own privacy policy, not this one.
- **Remote Access (mobile monitoring)** — when you start it from Settings, Parallel Code runs a local HTTP and WebSocket listener bound to all of your machine's network interfaces, so devices on your LAN — or any device that can reach an address shown by the app — can connect. No traffic is routed through infrastructure operated by the Parallel Code project.
  - **Transport.** Traffic is unencrypted HTTP, and the access token is included in the URL (e.g. in the QR code). **Treat that URL as a credential.** Anything that captures the URL has the token until you restart Remote Access — including a photo of the QR code (which may be auto-backed up by your phone), mobile browser history or cross-device sync, clipboard managers, screen-sharing or screen-recording tools, and corporate TLS-inspection proxies or appliances that log HTTP URLs. Treat the network it runs on as trusted (a private LAN or a Tailscale tailnet), and stop the server when you're done.
  - **Tokens.** A fresh bearer token is generated each time the server starts and is not persisted by the desktop app; previous tokens become invalid on restart. The mobile client stores the token it receives in its browser `localStorage` so the same device can reconnect without rescanning; the token persists there in plaintext until you clear browser data on the device or restart Remote Access.
  - **Capabilities.** A client holding only the URL token is **read-only** — it can see the list of running agents, their recent terminal output, and task notes, but cannot send input, stop agents, edit notes, or create tasks. Typing into agents, editing notes, and creating tasks require **pairing**: entering a short-lived 6-digit code shown on the desktop, which mints a separate paired token on that phone. Resizing and stopping agents are never available to a phone.
  - **"Tailscale-like" detection.** Parallel Code labels an interface as Tailscale-like when it finds a non-internal IPv4 address beginning with `100.`; addresses starting with `172.` (often used by Docker bridges) are excluded from the displayed "WiFi" URL. The check is heuristic and does not verify the interface is actually Tailscale, so only treat that option as Tailscale if you know the address belongs to your tailnet. If your host has a VPN, virtualisation bridge, or unusual NIC, the URL shown may be reachable from a wider network than your LAN.
  - **Over Tailscale.** Traffic is carried by your tailnet — typically a direct WireGuard connection between your devices, but Tailscale's coordination service and (when direct connection is not possible) DERP relays may be involved per [Tailscale's network architecture](https://tailscale.com/kb/1257/connection-types). How Tailscale handles that traffic is governed by Tailscale's own policies, not this one.
- **Sub-task coordinator (MCP)** — when sub-tasks run under a coordinator agent, Parallel Code starts a local token-protected HTTP/WebSocket server so sub-task agents can call back into the app (e.g. to signal completion). No traffic from this feature passes through infrastructure operated by the Parallel Code project.
  - **Bind address.** When MCP starts its own listener, it binds to `127.0.0.1` except on macOS Docker setups, where it binds to `0.0.0.0` so containers can reach it via `host.docker.internal` — this also makes the port reachable from other hosts on your LAN, though access still requires the token. If a Remote Access server is already running when a coordinator starts, the coordinator reuses that listener; because Remote Access binds to `0.0.0.0`, MCP routes inherit that LAN reach on any platform (including Linux), though access still requires the MCP token.
  - **Where the token can land.** Token-bearing MCP data is written or passed in several places: a worktree `.mcp.json` when a worktree path is available, or a project-root `.mcp.json` otherwise, so the coordinator agent can auto-discover the server (Parallel Code also adds `.mcp.json` to your `.git/info/exclude` so it is not committed); a non-Docker coordinator config in your OS temp directory named `parallel-code-mcp-<coordinatorTaskId>.json`; per-sub-task configs in your OS temp directory for host-mode sub-tasks (`parallel-code-subtask-<taskId>.json`) or under the coordinator's `.parallel-code/` directory for Docker sub-tasks (`subtask-<taskId>.json`); and short-lived `.parallel-code-atomic-<uuid>.tmp` files written next to these configs during atomic-rename steps. These files are written with `0600` permissions where the platform supports it.
  - **Codex token in the command line.** For Codex specifically, the MCP token is passed as a literal command-line argument (`--config mcp_servers.parallel-code={... env = { PARALLEL_CODE_MCP_TOKEN = "..." }}`). Process command lines are visible to other processes — via `/proc/<pid>/cmdline` on Linux or `ps` on macOS — so any local process that runs concurrently with a Codex sub-task can read that token and call back into the coordinator under its authority until the coordinator exits. Other agents receive the token through a token-protected file or env var instead.
- **Docker task isolation** — when you enable Docker mode for a task, or when you opt coordinator sub-tasks into Docker-isolated mode, the agent launches in a container via `docker run --network host`. **Docker mode is not a security boundary.** It isolates the filesystem against the worktree, but does not isolate the network or credentials from the agent.
  - **Network.** `--network host` means the container shares the host's network namespace; its outbound reachability is the same as your host's, including loopback services and any LAN address your host can reach.
  - **Environment.** Most of your shell environment is forwarded into the container with `-e`. A blocklist strips host-specific variables — `PATH`, `HOME`, all temp-dir vars (`TMPDIR`/`TEMPDIR`/`TMP`/`TEMP`), display/desktop session vars (`DISPLAY`, `WAYLAND_DISPLAY`, `DBUS_*`, `XAUTHORITY`), linker overrides (`LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*`), session vars (`LOGNAME`, `MAIL`), agent socket / k8s vars (`SSH_AUTH_SOCK`, `GPG_AGENT_INFO`, `KUBECONFIG`), and the `XDG_*`/`ELECTRON_*`/`SUDO_*`/`CLAUDE_CODE_*` families (the authoritative list is `DOCKER_ENV_BLOCK_LIST` in `electron/ipc/pty.ts`). **API keys and tokens in your shell are not on that blocklist** — for example `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`/`GH_TOKEN`, `HF_TOKEN`, or AWS credentials are forwarded into the container by default. Unset anything you do not want reaching the containerised agent before launching Parallel Code.
  - **Worktree mount.** The container bind-mounts the worktree (and its parent for coordinator tasks) plus the main repo's `.git` directory.
  - **Read-only credential mounts.** To allow the agent to authenticate to git/GitHub/npm/etc., the following host files are bind-mounted **read-only** into the container's home if they exist: `~/.ssh`, `~/.gitconfig`, `~/.config/gh`, `~/.npmrc`, `~/.netrc`, and the file pointed to by `$GOOGLE_APPLICATION_CREDENTIALS`. Read-only stops modification, not reading — the agent can still read and use any credential mounted this way.
  - **Writable shared agent auth (opt-in).** If you enable "Share agent auth across Linux containers" in Settings, Parallel Code creates and bind-mounts **writable** host directories under `~/.parallel-code/agent-auth/<agent>/` into the container's per-agent config locations (e.g. `~/.claude`, `~/.codex`, `~/.gemini`, `~/.config/opencode`, `~/.config/github-copilot`, and `~/.claude.json`), so the containerised agent can write fresh credentials on first login and reuse them on later runs. Those host directories then accumulate agent credentials in your home directory across sessions. For Claude specifically, Parallel Code also seeds `hasTrustDialogAccepted: true` and `hasCompletedProjectOnboarding: true` for the worktree path inside the mounted `.claude.json`, so the agent does not prompt for trust on first run in a freshly mounted container.

Across all of the above, no traffic is routed through servers operated by the Parallel Code project. Most of it does reach third parties — GitHub, Docker registries, MiniMax, Anthropic, OpenAI, your tailnet, or whatever your chosen AI CLI talks to — whose own privacy policies govern what they receive.

## OS-level integrations

A few features hand short pieces of data to your operating system itself:

- **Clipboard pasting and drag-drop** — when you paste into or drop content onto an agent prompt, Parallel Code reads the OS clipboard or the drop payload. If it contains a file reference (`public.file-url`, `text/uri-list`, or GNOME's `x-special/gnome-copied-files`), the file path is passed to the agent. If it contains an image, the image bytes are written to your OS temp directory so the agent can reference the image as a file path: clipboard pastes overwrite a single file at `$TMPDIR/parallel-code-clipboard.png`, and drops are written to `$TMPDIR/parallel-code-drop-<timestamp>-<random>[-<original-filename>]` — the original drop filename, if any, is sanitised and appended. These temp files are not deleted by Parallel Code; they remain in your temp directory until your OS cleans it (typically on reboot or via periodic cleanup). Plain text is inserted into the prompt. As with any prompt, once you submit it (or the app detects it as prompt input from the terminal), it can be stored locally as task metadata (the task's `lastPrompt`) in `state.json`.
- **Clipboard writes** — when you click "Copy" in certain UI controls (for example the Connect Phone dialog), Parallel Code writes to the OS clipboard. The Remote Access URL it copies contains the **session bearer token** as a query parameter, so anything that reads or syncs your clipboard (clipboard managers, screen-sharing tools, cross-device clipboard sync) will see that token until you copy something else or restart Remote Access. Other clipboard writes (terminal selection, theme prompts, task steps) carry only the content you asked to copy.
- **Native notifications** — when a task completes, needs attention, or when GitHub PR checks succeed or fail, Parallel Code uses the OS notification API. The notification's title and body (typically the task name and a short status; for failed PR checks, the failed check names) are visible to the operating system and any surfaces that mirror notifications (Notification Center, etc.).
- **Microphone entitlement (macOS)** — the packaged macOS app declares `NSMicrophoneUsageDescription` and the corresponding hardened-runtime entitlement, so the OS will permit microphone access if a feature requests it. The current build contains no active microphone capture code; granting the permission has no effect until a microphone-using feature ships. Note that the renderer permission handler in `electron/main.ts` auto-approves audio media requests — so if microphone-using code is added later, the only consent gate will be the OS-level microphone prompt.
- **Rendered markdown** — plan content shown in the task notes panel and the plan viewer dialog, plus any `.md` files you open from the UI, are rendered to HTML by the app for display. The renderer sanitises the output but allows standard image (`<img>`) and link (`<a>`) tags. If markdown rendered in the UI contains an external `<img src="https://...">` reference — for example because an agent wrote one into a plan or markdown file — your renderer will fetch that resource directly from the third-party host as soon as the content is shown, leaking your IP and the resource URL to that host. Parallel Code does not insert such references itself.

## Local storage locations

Configuration and state are kept in standard per-OS application directories — on macOS under `~/Library/Application Support/Parallel Code`, on Linux under `~/.config/Parallel Code`. Files in those directories include:

- `state.json` and a rolling `state.json.bak` (overwritten on the next save) so a corrupted write does not lose your tasks.
- `keybindings.json` and `keybindings.json.bak` for custom keybindings.
- `themes/` — custom theme CSS files.
- `arena-presets.json` and `arena-history.json` for the Arena feature.
- `.updaterId` — the per-install UUID sent in the `x-user-staging-id` header on update checks (see Application updates).
- Chromium's standard cache and storage directories (`Cache/`, `Code Cache/`, `GPUCache/`, `Local Storage/`, `IndexedDB/`, `Network/`, and similar) are also created inside the userData directory at first launch. Parallel Code's renderer does not use `localStorage`, `IndexedDB`, cookies, or service workers, so these directories hold only Chromium's own asset caches — not application state or user content.

Inside the git repositories you point the app at, Parallel Code may also write:

- `.claude/` — for Claude Code, Parallel Code seeds empty `settings.json` and `settings.local.json` placeholders on every spawn (so the bwrap sandbox can bind-mount them) and holds `steps.json` for agent step tracking. When sub-tasks run, `.claude/settings.local.json` also carries the coordinator preamble described under _Third-party AI coding CLIs_ above, plus similar agent-scoped scratch state.
- `.parallel-code/` — when you use Docker mode or coordinator sub-tasks, this is created in the worktree for coordination state, project Docker configuration (e.g. an optional `.parallel-code/Dockerfile`), and per-sub-task MCP token configs.
- `.git/info/exclude` — Parallel Code appends `.mcp.json`, `.parallel-code/`, `.claude/steps.json`, and a small set of bwrap bind-mount artifact placeholders (`/.bashrc`, `/.gitconfig`, `/.zshrc`, and similar) so these app-managed paths do not surface in `git status`.

Other places Parallel Code can write state:

- `~/.parallel-code/agent-auth/<agent>/` — only if you enable "Share agent auth across Linux containers" (see Docker task isolation); accumulates agent credentials across sessions.
- OS temp directory (`$TMPDIR`) — `parallel-code-clipboard.png` and the `parallel-code-drop-*` files from clipboard/drop image handling (not deleted by Parallel Code), plus the host-mode coordinator and sub-task MCP configs and `.parallel-code-atomic-<uuid>.tmp` files described under Sub-task coordinator above.

Persistence the app itself does not control but that mirrors content the app produced:

- The mobile client's bearer token persists in browser `localStorage` on the paired device until you clear browser data on that device or restart Remote Access (which invalidates the previous token).
- Native notifications (task completion, PR check results) typically remain in the operating system's notification centre until you clear it.

Stop any running agents and coordinator sessions before deleting app-generated state so the app is not mid-write when files disappear. Also review `.parallel-code/` before deleting it, because it may contain project-owned configuration such as `.parallel-code/Dockerfile`, not only disposable coordination files.

## Your data and rights

Because the project itself collects no personal data on infrastructure it controls, there is nothing for the project to delete or export on your behalf. Local data can be removed at any time by deleting the files and directories listed above. For data sent to third parties (your AI CLI vendor, GitHub, MiniMax, etc.), any data-subject rights under applicable law (GDPR, CCPA, and similar) are exercised directly with those services under their own policies.

## Children's privacy

Parallel Code is a developer tool aimed at software developers, not children, and is not directed at users under 13. The project itself operates no servers and does not collect personal data on infrastructure it controls. The network requests Parallel Code does make (see _Network activity initiated by Parallel Code itself_ above) carry standard HTTP metadata such as your IP address to the destinations listed there; data those third parties receive is governed by their own privacy policies, not this one.

## Changes to this policy

If this policy changes, the update will appear in this file in the project repository, and the "Last updated" date above reflects the current version. Material changes (new outbound network calls, new categories of data, or significant changes to existing disclosures) will also be called out in the project's release notes. The full revision history is available via `git log -- PRIVACY.md` in the project repository.

## Contact

Parallel Code is maintained by Johannes Millan, the same author as [Super Productivity](https://super-productivity.com) — the email below is that author's general contact address and reaches the same person. Questions or concerns can be raised as an issue on the [GitHub repository](https://github.com/johannesjo/parallel-code/issues) or by email at [contact@super-productivity.com](mailto:contact@super-productivity.com). GitHub issues are public — please do not include personal data, secrets (API keys, tokens), or anything you would not want indexed by search engines. If a question requires sharing personal data, use email rather than posting it publicly.

This policy is published alongside the project's open-source license: the project follows the behavior described above and will update this document when that behavior changes. The software itself is provided without warranty under the terms of the project's license.
