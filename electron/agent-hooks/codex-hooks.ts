import path from 'path';
import { HOOK_TIMEOUT_SECONDS, shellQuote } from './claude-settings.js';

/** Codex allows an `Interrupt` hook this long, and warns at startup about more. */
const INTERRUPT_TIMEOUT_SECONDS = 3;

/**
 * The events that move status. Codex has no idle or failure notification, and
 * its `SessionStart` says nothing here: it runs with the first prompt, not when
 * the session is ready.
 */
const EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
  'Interrupt',
] as const;
const TOOL_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
]);

/** A hook as Codex identifies it, and the hash of its definition Codex trusts. */
export interface CodexHookTrust {
  key: string;
  hash: string;
}

/** True for `codex` and absolute paths to it; wrappers with other names get nothing. */
export function isCodexCommand(command: string): boolean {
  return path.basename(command) === 'codex';
}

/**
 * One `hooks.<Event>=…` config override per event, registering the app's hook
 * script for a single Codex launch. Passed as flags, so the user's own Codex
 * configuration and hooks are left as they are.
 */
export function buildCodexHookOverrides(hookScriptPath: string): string[] {
  // A TOML basic string takes the escapes JSON writes.
  const command = JSON.stringify(`/bin/sh ${shellQuote(hookScriptPath)}`);
  return EVENTS.map((event) => {
    const timeout = event === 'Interrupt' ? INTERRUPT_TIMEOUT_SECONDS : HOOK_TIMEOUT_SECONDS;
    const matcher = TOOL_EVENTS.has(event) ? 'matcher="*",' : '';
    return `hooks.${event}=[{${matcher}hooks=[{type="command",command=${command},timeout=${timeout}}]}]`;
  });
}

/**
 * The override that marks those hooks as reviewed, so Codex runs them without
 * its review dialog. One inline table: Codex splits a dotted `-c` path at the
 * dots inside a quoted key, and then ignores the entry.
 */
export function buildCodexTrustOverride(hooks: readonly CodexHookTrust[]): string {
  const rows = hooks.map(
    ({ key, hash }) => `${JSON.stringify(key)}={trusted_hash=${JSON.stringify(hash)}}`,
  );
  return `hooks.state={${rows.join(',')}}`;
}

/**
 * True when the user's own arguments set hooks by flag. Such a launch is left
 * alone: how Codex combines two sets of hook flags is not something to guess at.
 */
export function hasCodexHookOverride(args: readonly string[]): boolean {
  return args.some((arg, index) => {
    // The value of a config flag, given apart from it or attached; a prompt is neither.
    const apart = /^(?:--config|-c)$/.test(args[index - 1] ?? '') && /^hooks[.=]/.test(arg);
    return apart || /^(?:--config=|-c=?)hooks[.=]/.test(arg);
  });
}

/** Config overrides as Codex command-line arguments. */
export function codexConfigArgs(overrides: readonly string[]): string[] {
  return overrides.flatMap((override) => ['-c', override]);
}
