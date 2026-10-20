import type {
  PermissionMode,
  ResolvedSettings,
  SettingSource,
} from '@anthropic-ai/claude-agent-sdk';

/** The settings tiers a chat session reads, which is what its `query()` is given too. */
const SETTING_SOURCES: readonly SettingSource[] = ['user', 'project', 'local'];

export const chatSettingSources = (): SettingSource[] => [...SETTING_SOURCES];

/** Tiers a checkout can carry: `.claude/settings.json` is committed outright, and
 *  nothing stops a repository shipping the `.local.json` that convention ignores. */
const REPO_TIERS: readonly string[] = ['project', 'local'];

/** Modes the CLI takes only from a tier the user owns. Measured against CLI 2.1.276,
 *  which resolves `auto` and `bypassPermissions` to `default` when either repo tier
 *  asks for them, and honours `acceptEdits` from any tier. */
const USER_TIER_ONLY: readonly string[] = ['auto', 'bypassPermissions'];

/** Whether the checkout, rather than the user or an administrator, asked for `mode`. */
function askedByRepo(resolved: ResolvedSettings, mode: string): boolean {
  const asked = [...resolved.sources]
    .reverse() // Sources run low to high precedence; the last to set the mode owns it.
    .find((source) => source.settings.permissions?.defaultMode === mode);
  return !!asked && REPO_TIERS.includes(asked.source);
}

/**
 * The `permissions.defaultMode` Claude Code itself would honour for `cwd`, or
 * `undefined` when no tier it trusts asks for one.
 *
 * The chat has to resolve this itself: the SDK sends `--permission-mode` on every
 * session it starts, and that flag outranks the settings file, so the CLI never
 * gets to apply `defaultMode` on its own the way it does in a terminal.
 *
 * The merge is the SDK's own engine, not a cascade of ours, and what it returns
 * passes two trust filters rather than one. `filterEscalatingDefaultMode` is the
 * SDK's, and it covers the committed `project` tier only; the CLI itself also
 * refuses an escalating mode from `settings.local.json`, so `askedByRepo` covers
 * that. Which matters because a worktree holding code the user has not read is
 * exactly what this app opens: honouring it would let a repository grant itself
 * a session that stops asking.
 *
 * Loaded on demand, the way the session itself loads the SDK, so starting the app
 * never pays for a chat nobody opened.
 */
export async function settingsDefaultMode(cwd: string): Promise<string | undefined> {
  try {
    const { resolveSettings, filterEscalatingDefaultMode } =
      await import('@anthropic-ai/claude-agent-sdk');
    const resolved = await resolveSettings({ cwd, settingSources: chatSettingSources() });
    const mode = filterEscalatingDefaultMode(resolved).permissions?.defaultMode;
    if (!mode) return undefined;
    return USER_TIER_ONLY.includes(mode) && askedByRepo(resolved, mode) ? undefined : mode;
  } catch (error) {
    // Settings are the user's to fix and Claude Code reports them itself. Never
    // let one stop the chat from opening; the caller uses the app default.
    console.warn('Ignoring unreadable Claude Code settings:', error);
    return undefined;
  }
}

/** The modes a chat session may launch itself in on the strength of a settings file.
 *  Typed against the SDK's own union, so a mode it renames stops the build rather
 *  than quietly becoming a mode this app no longer forwards. */
const LAUNCHABLE = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
] as const satisfies readonly PermissionMode[];

/**
 * A settings `defaultMode` as a mode the session can launch in, or `undefined`
 * when the session should not adopt it.
 *
 * `bypassPermissions` is the one mode deliberately left behind: running a whole
 * session unprompted belongs to the task's own "skip permissions" switch, which
 * is also what passes the CLI's opt-in flag for it.
 */
export function launchPermissionMode(mode: string | undefined): PermissionMode | undefined {
  // 'manual' is what the CLI calls the asking mode on the command line; the SDK
  // and the session's own reports still call the same mode 'default'.
  if (mode === 'manual') return 'default';
  return LAUNCHABLE.find((launchable) => launchable === mode);
}
