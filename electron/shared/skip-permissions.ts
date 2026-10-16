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
  ['kimi', ['--yolo']],
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

/**
 * Skip-permissions flags for an agent definition, preferring what the
 * definition carries and falling back to the table above.
 *
 * The fallback is the point. An `AgentDef` can reach a launch path with
 * `skip_permissions_args` empty — restored from a profile written before the
 * field existed, or synthesised from a bare command — and reading the field
 * directly silently turns an explicit `skipPermissions: true` into a launch
 * that prompts on every tool call.
 */
export function resolveSkipPermissionsArgs(def: {
  command: string;
  skip_permissions_args?: string[];
}): string[] {
  return def.skip_permissions_args?.length
    ? [...def.skip_permissions_args]
    : getSkipPermissionsArgs(def.command);
}

/** True when a flag's value turns permission prompts off. */
type DangerousValue = (value: string) => boolean;

interface BypassRules {
  /** Flags that bypass permission prompts on their own. */
  flags: readonly string[];
  /** Flags that bypass only for some values. */
  valued: ReadonlyMap<string, DangerousValue>;
  /** Flags stripped only after the first positional, i.e. from the wrapped agent. */
  wrappedFlags?: readonly string[];
}

function unquote(value: string): string {
  return value.trim().replace(/^(['"])(.*)\1$/, '$2');
}

const oneOf =
  (...values: string[]): DangerousValue =>
  (value) =>
    values.includes(unquote(value));

/** Codex `-c key=value` overrides that match `-a never` / `-s danger-full-access`. */
const codexConfigOverride: DangerousValue = (value) => {
  const eq = value.indexOf('=');
  if (eq === -1) return false;
  // A profile-scoped key (`profiles.x.approval_policy`) takes effect with that profile.
  const key = value.slice(0, eq).trim().split('.').pop();
  // Loose on purpose: TOML also accepts a trailing comment, escapes and triple quotes.
  const setting = value
    .slice(eq + 1)
    .split('#')[0]
    .replace(/["'\\]/g, '')
    .trim();
  return (
    (key === 'approval_policy' && setting === 'never') ||
    (key === 'sandbox_mode' && setting === 'danger-full-access')
  );
};

const BYPASS_RULES = new Map<string, BypassRules>([
  [
    'claude',
    {
      flags: ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions'],
      valued: new Map([
        ['--permission-mode', oneOf('bypassPermissions')],
        // Inline JSON or a file path; only the inline form can be inspected.
        ['--settings', (value: string) => value.includes('bypassPermissions')],
      ]),
    },
  ],
  [
    'codex',
    {
      // --yolo is a hidden alias of the bypass flag.
      flags: [
        '--dangerously-bypass-approvals-and-sandbox',
        '--yolo',
        '--dangerously-bypass-hook-trust',
      ],
      valued: new Map([
        ['-s', oneOf('danger-full-access')],
        ['--sandbox', oneOf('danger-full-access')],
        ['-a', oneOf('never')],
        ['--ask-for-approval', oneOf('never')],
        ['-c', codexConfigOverride],
        ['--config', codexConfigOverride],
      ]),
    },
  ],
  [
    'gemini',
    {
      flags: ['-y', '--yolo'],
      // yargs accepts the camelCase spelling too.
      valued: new Map([
        ['--approval-mode', oneOf('yolo')],
        ['--approvalMode', oneOf('yolo')],
      ]),
    },
  ],
  [
    'copilot',
    {
      flags: ['--yolo', '--allow-all', '--allow-all-tools', '--allow-all-paths'],
      valued: new Map(),
    },
  ],
  ['agy', { flags: ['--dangerously-skip-permissions'], valued: new Map() }],
]);

function bypassRulesFor(command: string): BypassRules {
  const basename = command.split('/').filter(Boolean).pop() ?? command;
  const known = BYPASS_RULES.get(basename);
  if (known) return known;
  // Unknown command: strip the union rather than guess which agent it wraps.
  const all = [...BYPASS_RULES.values()];
  const valued = new Map<string, DangerousValue>();
  for (const rules of all) {
    for (const [flag, dangerous] of rules.valued) {
      const prior = valued.get(flag);
      valued.set(flag, prior ? (value) => prior(value) || dangerous(value) : dangerous);
    }
  }
  // Short bare flags are too generic for the wrapper itself (`npx -y`), so they are
  // stripped only from the wrapped agent's args after the first positional.
  const flags = all.flatMap((rules) => rules.flags);
  return {
    flags: flags.filter((flag) => flag.startsWith('--')),
    valued,
    wrappedFlags: flags.filter((flag) => !flag.startsWith('--')),
  };
}

/** Split `--flag=value`, `-Xvalue` and `-X=value` (short valued flags only, the
 *  forms clap and commander accept) into name and attached value. */
function splitArg(arg: string, valued: BypassRules['valued']): { name: string; attached?: string } {
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=');
    return eq === -1 ? { name: arg } : { name: arg.slice(0, eq), attached: arg.slice(eq + 1) };
  }
  const short = arg.slice(0, 2);
  if (arg.length > 2 && arg[0] === '-' && valued.has(short)) {
    const rest = arg.slice(2);
    return { name: short, attached: rest.startsWith('=') ? rest.slice(1) : rest };
  }
  return { name: arg };
}

/**
 * Drop every argument that makes a child agent skip permission prompts, for use
 * when the parent did not opt into propagating skip-permissions. Value-aware:
 * `--permission-mode bypassPermissions` and `--permission-mode=bypassPermissions`
 * go, `--permission-mode plan` stays.
 *
 * Best effort against the user's own configured args, not a sandbox: a codex
 * `--profile`, a settings file, the agent env file, TOML escapes or short-flag
 * clusters (`-yd`) can still enable bypass and are not inspected. Narrower
 * grants (`--permission-mode acceptEdits`, `--allowedTools`, codex
 * `--approve-for-me`, copilot `--allow-tool`) are kept. For unknown commands a
 * wrapper option's value counts as the first positional, so `npx --package p -y`
 * loses its `-y`: erring towards stripping.
 */
export function stripPermissionBypassArgs(command: string, args: readonly string[]): string[] {
  const rules = bypassRulesFor(command);
  const out: string[] = [];
  let afterPositional = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    afterPositional ||= !arg.startsWith('-');
    const { name, attached } = splitArg(arg, rules.valued);
    if (rules.flags.includes(name)) continue;
    if (afterPositional && rules.wrappedFlags?.includes(name)) continue;
    const dangerous = rules.valued.get(name);
    const value = attached ?? args[i + 1];
    if (!dangerous || value === undefined || !dangerous(value)) {
      out.push(arg);
      continue;
    }
    if (attached === undefined) i++;
  }
  return out;
}
