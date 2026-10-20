#!/usr/bin/env node
/* global console, process */
/**
 * Stands in for `claude` or `codex` in showcase runs that opt in to real
 * agents (`realAgents` in electron-app.ts). It rewrites the arguments so the
 * agent can only use the provider's cheapest model, then runs the real binary.
 *
 * Usage: pinned-agent.mjs <claude|codex> <real binary> [agent args...]
 */
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const HAIKU = 'claude-haiku-4-5-20251001';

const PINNED_MODELS = {
  claude: {
    args: ['--model', 'haiku'],
    // The aliases /model offers, and subagents, resolve to Haiku as well.
    env: {
      ANTHROPIC_DEFAULT_OPUS_MODEL: HAIKU,
      ANTHROPIC_DEFAULT_SONNET_MODEL: HAIKU,
      CLAUDE_CODE_SUBAGENT_MODEL: HAIKU,
      // Fast mode bills more, and its notice would show in recordings.
      CLAUDE_CODE_DISABLE_FAST_MODE: '1',
      // The login would otherwise bring the account's claude.ai connectors.
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      // No auto-update or telemetry, and no "Auto-update failed" notice.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    // --fallback-model would switch to another model when Haiku is overloaded.
    valueFlags: ['--model', '--fallback-model'],
    configFlags: [],
    refused: [],
  },
  codex: {
    // A config override rather than -m: it is accepted before any subcommand.
    args: ['-c', 'model="gpt-6-luna"'],
    env: {},
    // A profile can name its own model, and it wins over `-c model=`.
    valueFlags: ['-m', '--model', '-p', '--profile'],
    configFlags: ['-c', '--config'],
    // These take the model per request (JSON-RPC, MCP), past any argument.
    refused: ['app-server', 'mcp-server'],
  },
};

const PINNED_CONFIG_KEYS = new Set(['model', 'profile']);

const pinsModel = (configValue) => PINNED_CONFIG_KEYS.has(configValue.split('=')[0].trim());

/** Returns the flag an argument sets inline (`--model=x`, `-mx`), if any. */
const inlineFlag = (arg, flags) =>
  flags.find((flag) =>
    flag.startsWith('--') ? arg.startsWith(`${flag}=`) : arg.startsWith(flag) && arg.length > 2,
  );

const inlineValue = (arg, flag) => arg.slice(flag.length + (flag.startsWith('--') ? 1 : 0));

/**
 * Removes every argument that could pick a model, then prepends the pinned
 * one. Arguments after `--` are prompt text and stay as they are.
 */
export const pinModelArgs = (agent, args) => {
  const pin = PINNED_MODELS[agent];
  if (!pin) throw new Error(`No pinned model for "${agent}"`);
  const end = args.includes('--') ? args.indexOf('--') : args.length;
  const refused = args.slice(0, end).find((arg) => pin.refused.includes(arg));
  if (refused) {
    throw new Error(`${agent} ${refused} is disabled in showcase runs: it cannot pin the model`);
  }
  const kept = [];
  for (let i = 0; i < end; i++) {
    const arg = args[i];
    if (
      pin.valueFlags.includes(arg) ||
      (pin.configFlags.includes(arg) && pinsModel(args[i + 1] ?? ''))
    ) {
      i++; // and its value
      continue;
    }
    const configFlag = inlineFlag(arg, pin.configFlags);
    if (
      inlineFlag(arg, pin.valueFlags) ||
      (configFlag && pinsModel(inlineValue(arg, configFlag)))
    ) {
      continue;
    }
    kept.push(arg);
  }
  return [...pin.args, ...kept, ...args.slice(end)];
};

const run = (agent, realBinary, args) => {
  const child = spawn(realBinary, pinModelArgs(agent, args), {
    stdio: 'inherit',
    env: { ...process.env, ...PINNED_MODELS[agent].env },
  });
  // Ctrl-C already reaches the agent through the terminal's process group;
  // forwarding it as well would count as a second press.
  process.on('SIGINT', () => {});
  for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('error', (error) => {
    console.error(`${agent}: could not start ${realBinary}: ${error.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [agent, realBinary, ...args] = process.argv.slice(2);
  try {
    run(agent, realBinary, args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
