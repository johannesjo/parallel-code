/**
 * Which flag each built-in agent CLI takes to skip its own permission prompts.
 *
 * Lives here rather than beside `DEFAULT_AGENTS` because the renderer needs the
 * same answer: it builds an agent's launch args synchronously at spawn time,
 * and `electron/ipc/agents.ts` imports `child_process`, so it cannot reach it.
 * One table means both processes resolve an agent's flags identically instead
 * of each call site reading whatever `AgentDef` it happens to be holding.
 *
 * A command absent from this table takes no such flag. `opencode` is the
 * built-in example: it is deliberately not listed rather than listed as empty.
 *
 * A `Map` rather than an object literal because `command` is free text from the
 * custom agent editor: an object lookup resolves inherited keys, so an agent
 * named `constructor` or `toString` would read back a prototype member instead
 * of nothing. `Map` has no such keys to inherit.
 */
const SKIP_PERMISSIONS_ARGS = new Map<string, readonly string[]>([
  ['claude', ['--dangerously-skip-permissions']],
  ['codex', ['--dangerously-bypass-approvals-and-sandbox']],
  ['gemini', ['--yolo']],
  ['copilot', ['--yolo']],
  ['agy', ['--dangerously-skip-permissions']],
]);

/**
 * Skip-permissions flags for a command, matched on its basename so an absolute
 * path (`/opt/homebrew/bin/claude`) resolves the same as a bare `claude`.
 *
 * Split rather than `path.basename` so this module keeps no Node imports, the
 * way the rest of `electron/shared/` does — the same split `src/lib/agent-args.ts`
 * already uses on these commands. Empty segments are dropped so a trailing
 * slash resolves the way `path.basename` would.
 *
 * Returns a fresh array: callers spread it into argv lists, and the table must
 * not be reachable for mutation.
 */
export function getSkipPermissionsArgs(command: string): string[] {
  const basename = command.split('/').filter(Boolean).pop() ?? command;
  return [...(SKIP_PERMISSIONS_ARGS.get(basename) ?? [])];
}
