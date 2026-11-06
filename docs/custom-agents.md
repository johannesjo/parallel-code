# Custom agents

Parallel Code has built-in support for Claude Code, Codex CLI, OpenCode, Copilot CLI and Antigravity CLI. Any other agent that runs in a terminal can be added as a custom agent and then picked in the New task dialog like the built-in ones.

Add, edit or remove one under **Settings → Agents → Custom agents**.

## The fields

| Field                     | Required | What it does                                                                                                                                                                             | Example                              |
| ------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **Name**                  | yes      | Shown in the agent picker and on task cards.                                                                                                                                             | `Gemini`                             |
| **Command**               | yes      | The program to run. A name on your `PATH` or an absolute path. Use an absolute path if the agent exits at once with "command not found".                                                 | `gemini`, `/opt/homebrew/bin/gemini` |
| **Launch args**           | no       | Added to every fresh start, for example a model.                                                                                                                                         | `--model gemini-2.5-pro`             |
| **Resume args**           | no       | Used **instead of** the launch args when Parallel Code reopens a task after a restart, to continue its conversation. Leave it empty and a reopened task starts a new conversation.       | `--resume latest`                    |
| **Skip permissions args** | no       | Added when a task has **Skip permissions** ticked in the New task dialog. The checkbox appears for agents that have these args, or whose command is one Parallel Code knows (see below). | `--yolo`                             |

Arguments are split on spaces, and quotes are not supported, so a single argument can't contain a space. If you need that, point **Command** at a small wrapper script that passes the arguments on.

The flags in the examples are illustrations: check your agent's `--help`, since flags change between versions.

### How a launch is put together

```text
<command> <launch args or resume args> <pane flags> <skip permissions args> <MCP args>
```

- **Pane flags** are what **Resume with flags…** on an agent pane added to that one pane.
- **Skip permissions args** are added only for tasks that skip permissions.
- **MCP args** are added only when the task takes part in agent orchestration (see below).

### Editing an agent

**Edit** opens the same form with the current values. The agent keeps its identity, so its env file and the tasks that use it stay linked. Changes apply the next time an agent starts or restarts: an agent that is already running keeps the launch it started with. Flags added to one pane with **Resume with flags…** are kept.

## Credentials and environment

Parallel Code starts each agent from your login shell's environment. If the agent needs variables your shell doesn't export, such as an API key, put them in a `KEY=VALUE` file and pick it for that agent under **Settings → Agents → Agent environment**.

For Docker tasks the agent runs inside the container, so it must be installed in the image (or in the project's `.parallel-code/Dockerfile`).

## What works differently from built-in agents

- **Status on the board.** For built-in agents other than Claude Code, and for every custom agent, Parallel Code works out whether the agent is working, waiting or asking a question from its terminal output. It recognises an input line that starts with `❯` or `›`. Other agents still work, but their status is less precise.
- **The first prompt.** A task's prompt is typed in once the agent shows its input line. For an agent whose input line Parallel Code doesn't recognise, it is typed once the output has stayed unchanged for about 1.5 seconds. It is held while the screen shows a numbered menu whose cursor is `❯` or `›` (`❯ 1. …`) or a question Parallel Code recognises; answer the agent and the prompt goes in afterwards. Menus drawn differently, for example inside a box or with `●` or `>` as the cursor, are not recognised, so answer any startup dialog before the prompt is due.
- **Commands named like a built-in agent.** Parallel Code recognises some agents by the command's file name and gives a custom agent with such a command that agent's handling. `claude` gets Claude Code's status hooks, session IDs and MCP flag. Any name that contains `codex`, such as a wrapper called `my-codex`, gets Codex's session handling and MCP config. `copilot` gets its own MCP flag, and `agy` none, since Parallel Code writes its workspace MCP config instead. `claude`, `codex`, `gemini`, `copilot` and `agy` also get a default skip-permissions flag when that field is empty. A wrapper script with any other name gets the generic handling.
- **Tours, reviews and code questions** run only with Claude Code, Codex or MiniMax, chosen in Settings, not with custom agents.
- **The chat view** is only available for Claude Code and Codex.
- **Agent orchestration.** When a custom agent with a command it doesn't recognise runs a coordinated task, Parallel Code adds `--mcp-config <file>`, as for Claude Code. Use a custom agent there only if it accepts that flag.

## Checking a new agent

1. Run the command with your launch args in a terminal inside the project folder. It should start its interactive prompt.
2. Start a task with a short prompt, such as "list the files here". The prompt should be typed in and the card should move to **Working**, then out of **Working** when the agent finishes its turn. If it asks you something, the card moves to **Needs you**.
3. If you set resume args, quit and reopen Parallel Code. The task should come back in the same conversation.
4. If you set skip permissions args, start a task with **Skip permissions** ticked and check that the agent doesn't ask before running tools.

If a step fails, run the same command line in a terminal to see the agent's own error, then fix the field with **Edit**.
