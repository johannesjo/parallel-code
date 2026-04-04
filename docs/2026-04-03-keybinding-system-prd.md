# PRD: Configurable Keybinding System with Agent Presets

**Author:** Islam Shaalan
**Date:** 2026-04-03
**Status:** Draft

---

## 1. Problem Statement

Parallel Code's keyboard shortcuts conflict with the terminal-based coding agents that run inside it. When a user presses Option+Left to move the cursor one word back in Claude Code, Parallel Code intercepts it for column navigation and the keypress never reaches the terminal. When a user presses Cmd+Backspace to delete to line start, nothing happens at all.

This affects every user running a coding agent (Claude Code, Gemini CLI, Codex CLI, OpenCode) — which is the primary use case of the app. The conflicts are silent: the user presses a key, expects terminal behavior, and gets either an unrelated app action or nothing. There is no way to discover or resolve these conflicts without reading source code.

The cost of not solving this: frustrated users who can't use standard terminal shortcuts, workarounds that defeat the purpose of an integrated terminal experience, and a growing perception that Parallel Code "doesn't work right" with popular coding agents.

## 2. Goals

1. **Eliminate default conflicts with common coding agents** — users choosing a preset for their agent should have zero keybinding conflicts for that agent's documented shortcuts.
2. **Make keybindings discoverable and configurable** — users can see all bindings (App and Terminal layers), understand what each does, and change any of them.
3. **Preserve existing user muscle memory** — existing users are not forced into new defaults; migration is opt-in.
4. **Support macOS and Linux** — keybinding defaults and presets account for platform-specific modifier conventions (Cmd vs Ctrl, Option vs Alt).
5. **Keep the system maintainable** — adding a new agent preset or a new app shortcut should require minimal code changes.

## 3. Non-Goals

1. **Windows support** — the app does not currently support Windows. Keybinding design should not block future Windows support but does not need to address it now. _(Different initiative, different timeline.)_
2. **Per-task keybinding profiles** — all terminals in a session share the same keybinding configuration. Switching presets per task is out of scope. _(Premature complexity; most users run one agent type.)_
3. **Importing/exporting keybinding configs** — no JSON import/export or sharing mechanism in v1. _(Low impact; can add later if requested.)_
4. **Remapping keys inside the coding agent itself** — this system controls what Parallel Code intercepts vs passes through. What the agent does with the keypress is the agent's responsibility. _(Out of our control.)_
5. **Vim/Emacs modal keybinding schemes for the app itself** — presets only address terminal passthrough conflicts, not replacing the entire app shortcut scheme. _(Scope creep.)_

## 4. User Stories

### Primary Persona: Developer using a coding agent

1. **As a Claude Code user on macOS**, I want Option+Left/Right to move my cursor between words in the terminal, so that I can edit prompts efficiently without the app intercepting these keys for column navigation.

2. **As a developer setting up Parallel Code for the first time**, I want to pick my coding agent from a list and have keybindings auto-configured, so that I don't have to manually discover and fix every conflict.

3. **As an existing Parallel Code user upgrading to a new version**, I want to keep my current keybindings by default and opt into new presets on my own terms, so that my workflow isn't disrupted by a surprise update.

4. **As a developer who uses multiple agents** (e.g., Claude Code for some tasks, Gemini CLI for others), I want to manually adjust specific keybindings that conflict with my less-common agent, so that I have a setup that works across my tools.

5. **As a user rebinding a key**, I want to be warned if my new binding conflicts with an existing App or Terminal shortcut, so that I don't accidentally break something.

6. **As a user who made a mess of their keybindings**, I want to reset all bindings to defaults (or to a specific preset), so that I can start over without reinstalling the app.

7. **As a Linux user**, I want the default keybindings to use Ctrl instead of Cmd where appropriate, so that the shortcuts match my platform's conventions without manual adjustment.

## 5. Requirements

### Must-Have (P0)

**5.1 Two-layer keybinding model**

- All keyboard shortcuts are categorized into two layers:
  - **App layer**: shortcuts that Parallel Code intercepts globally (navigation, task actions, app commands)
  - **Terminal layer**: shortcuts that Parallel Code translates into escape sequences and sends to the PTY (Cmd+Left → Home, Shift+Enter → Alt+Enter, Cmd+Backspace → Ctrl+U, etc.)
- Each binding specifies: key, modifiers (Ctrl/Cmd/Alt/Shift), layer (App/Terminal), action/escape-sequence, and platform (macOS/Linux/both)
- Acceptance criteria:
  - [ ] Every current shortcut in `shortcuts.ts` and `TerminalView.tsx` is represented in the keybinding data model
  - [ ] The runtime shortcut system reads from the configurable data model, not hardcoded values
  - [ ] Changing a binding in the data model changes the runtime behavior without code changes

**5.2 Agent presets**

- Ship built-in presets for: **Default** (current behavior), **Claude Code**, **Gemini CLI**, **Codex CLI**, **OpenCode**
- Each preset is a set of overrides on top of the Default preset — only the bindings that differ are specified
- Selecting a preset applies its overrides and updates the active keybinding configuration
- Acceptance criteria:
  - [ ] Selecting "Claude Code" preset resolves all known conflicts between Parallel Code and Claude Code's documented shortcuts
  - [ ] Selecting "Default" restores the current (pre-feature) behavior exactly
  - [ ] Presets are defined as data (JSON-like objects), not spread across code

**5.3 Keybinding editor UI**

- Accessible from Settings (Cmd+,) as a new section, or as an evolution of the current Help dialog (Cmd+/)
- Displays all bindings grouped by layer (App / Terminal) and by category (Navigation, Task Actions, App, Terminal Mappings)
- Each row shows: description, current key combo, default key combo (if overridden), conflict indicator
- Users can click a binding to enter "recording mode" — press a new key combo to rebind
- Acceptance criteria:
  - [ ] All App-layer and Terminal-layer bindings are visible in the editor
  - [ ] User can rebind any shortcut by clicking and pressing a new key combo
  - [ ] Current binding is visually distinct from the default when overridden
  - [ ] Platform-appropriate modifier names are displayed (Cmd on macOS, Ctrl on Linux)

**5.4 Conflict detection and warnings**

- When a user records a new key combo that conflicts with an existing binding (in either layer), show a warning identifying the conflict
- The user can choose to: override (reassign the conflicting binding), cancel, or swap the two bindings
- Acceptance criteria:
  - [ ] Assigning Cmd+N to a terminal mapping warns that it conflicts with "New task" in the App layer
  - [ ] The warning identifies the conflicting binding by name and layer
  - [ ] User can proceed with the override (the conflicting binding becomes unbound)

**5.5 Reset to defaults**

- Per-binding reset: restore a single binding to its default (or preset default)
- Global reset: restore all bindings to a chosen preset
- Acceptance criteria:
  - [ ] A reset button appears next to any binding that differs from its default
  - [ ] "Reset all to [preset]" button restores the entire configuration
  - [ ] Reset requires confirmation when more than one binding is affected

**5.6 Persistence**

- Keybinding configuration is stored in a dedicated `keybindings.json` file in the app config directory (`~/.config/Parallel Code/`), separate from `state.json`
- Rationale: keybindings are durable configuration, not volatile app state. `state.json` writes on every window resize and task reorder — keybindings should not be at risk from those frequent writes. A dedicated file also makes keybindings portable and easy to back up.
- The file contains: selected preset name, and any user overrides on top of that preset. Format: `{ "preset": "claude-code", "overrides": { ... } }`
- Uses the same atomic-write pattern as `persistence.ts` (write to temp → validate → rename)
- Acceptance criteria:
  - [ ] Keybinding changes survive app restart
  - [ ] Only overrides are stored, not the full resolved configuration (keeps the file small and preset-upgradable)
  - [ ] Corrupted or missing `keybindings.json` falls back to Default preset without crashing
  - [ ] `keybindings.json` is only written when keybindings actually change, not on every app state save

**5.7 Opt-in migration for existing users**

- On first launch after this feature ships, existing users see a one-time, non-blocking notification/banner:
  > "Keyboard shortcuts are now configurable. Choose a preset for your coding agent in Settings, or keep your current defaults."
- No bindings change without user action
- Acceptance criteria:
  - [ ] Existing users see no behavior change until they explicitly choose a preset
  - [ ] The migration banner appears once and is dismissible
  - [ ] New installs default to "Default" preset (current behavior)

**5.8 Cmd+Backspace terminal mapping**

- Add Cmd+Backspace → `\x15` (Ctrl+U, kill line backward) to the default Terminal layer for macOS
- Currently this key combo does nothing; this is a gap, not a conflict
- Acceptance criteria:
  - [ ] Pressing Cmd+Backspace in a terminal on macOS sends `\x15` to the PTY
  - [ ] This mapping is included in the Default preset (benefits all users, not just agent-specific)

### Nice-to-Have (P1)

**5.9 Search/filter in keybinding editor**

- Text input to filter bindings by name, key combo, or category
- Useful as the binding list grows

**5.10 Help dialog reflects active bindings**

- The existing Help dialog (Cmd+/) should show the user's actual configured bindings, not hardcoded defaults
- This is a natural consequence of the data model but may require UI updates

### Future Considerations (P2)

**5.11 Keybinding chords**

- Support multi-key sequences (e.g., Ctrl+K followed by Ctrl+C)
- Not needed for any current conflict but some agents may use them

**5.12 Auto-suggest preset based on agent**

- When a user spawns an agent (e.g., `claude`), and their active preset doesn't match, show a subtle suggestion: "Using Claude Code? Try the Claude Code keybinding preset."
- The suggestion links directly to the preset selector
- Dismissible and doesn't reappear for the same agent after dismissal

## 6. Success Metrics

> **Note:** The codebase has no analytics or telemetry. These metrics are directional — measured via GitHub issues, community feedback, and manual observation. We are not implementing tracking infrastructure as part of this feature.

### Qualitative Indicators

- **Conflict-related issues**: reduction in GitHub issues mentioning "shortcut", "keybinding", "key", "Option+Arrow", "doesn't work". Target: 50% reduction.
- **Community feedback**: positive reception in release notes / discussions.

### Guardrail Metrics

- **Existing shortcut usage**: users who don't change presets should see zero regression in their current shortcut behavior.
- **App crash rate**: keybinding system should introduce no new crashes (corrupted state fallback is mandatory).

## 7. Open Questions

1. **Should the keybinding editor live in Settings (Cmd+,) or replace/extend the Help dialog (Cmd+/)?**
   - Owner: Design/UX decision
   - Blocking: No — can start with Settings and move later

2. **What are the exact keybinding conflicts for Gemini CLI, Codex CLI, and OpenCode?**
   - Owner: Engineering — requires testing each agent's documented shortcuts
   - Blocking: Only for shipping those specific presets; Claude Code preset can ship first

3. **Should presets override App-layer bindings, Terminal-layer bindings, or both?**
   - Owner: Product/Engineering
   - Recommendation: Both. A preset that can only change terminal mappings can't fix Option+Arrow (an App-layer conflict).
   - Non-blocking: can start with "both" and restrict later if needed

4. **How do we handle preset updates across app versions?**
   - If a preset gains new overrides in v1.5 but the user selected it in v1.4, should the new overrides apply automatically (since only user overrides are persisted) or require re-selection?
   - Owner: Engineering
   - Recommendation: Auto-apply. User overrides are explicit and preserved; preset improvements flow through automatically. This is why we store overrides, not the full resolved config.

## 8. Dependencies

- PR #15 (Linux clipboard behavior) should be merged first to avoid conflicts in TerminalView.tsx

## Appendix A: Known Keybinding Conflicts

| Key Combo (macOS) | Parallel Code Action | Agent Expectation                                   | Agents Affected                 |
| ----------------- | -------------------- | --------------------------------------------------- | ------------------------------- |
| Option+Left       | Column nav left      | Word left (`\x1bb` / Alt+B)                         | Claude, Gemini, Codex, OpenCode |
| Option+Right      | Column nav right     | Word right (`\x1bf` / Alt+F)                        | Claude, Gemini, Codex, OpenCode |
| Option+Up         | Task nav up          | — (blocks shell usage)                              | All                             |
| Option+Down       | Task nav down        | — (blocks shell usage)                              | All                             |
| Cmd+B             | Toggle sidebar       | Background task (Ctrl+B)                            | Claude Code                     |
| Cmd+Left          | Home (`\x1b[H`)      | — (works, but different from native macOS behavior) | —                               |
| Cmd+Right         | End (`\x1b[F`)       | — (works, but different from native macOS behavior) | —                               |
| Cmd+Backspace     | (nothing)            | Delete to line start (`\x15`)                       | All readline-based agents       |
| Escape            | Close dialogs        | Cancel input / Esc-Esc rewind                       | Claude Code                     |

## Appendix B: Proposed Claude Code Preset Overrides

These are the minimal changes from Default to resolve Claude Code conflicts:

| Binding                    | Default          | Claude Code Preset                                        |
| -------------------------- | ---------------- | --------------------------------------------------------- |
| Option+Left (App)          | Column nav left  | **Unbound** (passthrough to terminal)                     |
| Option+Right (App)         | Column nav right | **Unbound** (passthrough to terminal)                     |
| Cmd+Shift+Left/Right (App) | Reorder tasks    | **Also handles column nav** (absorbs Option+Arrow's role) |
| Cmd+Backspace (Terminal)   | (none)           | `\x15` (kill line backward)                               |
| Cmd+B (App)                | Toggle sidebar   | **Reassigned** to Cmd+Shift+B                             |

_Note: Option+Up/Down (task nav) do not conflict with Claude Code's documented shortcuts, so they remain bound. They do block shell Alt+Up/Down if the user needs those for other tools — this can be addressed per-user in the editor._
