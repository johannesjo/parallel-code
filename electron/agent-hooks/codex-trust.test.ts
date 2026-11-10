import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCodexHookArgs } from './codex-trust.js';

/**
 * A stand-in `codex`: answers `--version`, and as `app-server` lists the hooks
 * given by `-c hooks.<Event>=…`, trusted when `-c hooks.state=…` names their
 * hash. `mode` and `version` are files beside it, so a test can change them.
 */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const read = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8').trim();
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls'), args[args.length - 1] + '\\n');
if (args.includes('--version')) {
  console.log('codex-cli ' + read('version'));
  process.exit(0);
}
const mode = read('mode');
const overrides = args.filter((_, i) => args[i - 1] === '-c');
const state = overrides.find((o) => o.startsWith('hooks.state=')) ?? '';
const snake = (event) => event.replace(/[A-Z]/g, (c, i) => (i ? '_' : '') + c.toLowerCase());
const hooks = overrides
  .filter((o) => /^hooks\\.[A-Z]/.test(o))
  .map((o) => o.slice(6, o.indexOf('=')))
  .filter((event) => mode !== 'missing' || event !== 'Interrupt')
  .map((event) => {
    const key = '/<session-flags>/config.toml:' + snake(event) + ':0:0';
    const currentHash = 'sha256:' + event + read('version');
    const trusted = mode !== 'untrusted' && state.includes(JSON.stringify(key) + '={trusted_hash=' + JSON.stringify(currentHash) + '}');
    return { key, eventName: event, source: 'sessionFlags', enabled: true, currentHash, trustStatus: trusted ? 'trusted' : 'untrusted' };
  });
const user = { key: '/home/config.toml:stop:0:0', source: 'user', enabled: true, currentHash: 'sha256:user', trustStatus: 'untrusted' };
const warnings = mode === 'warns' ? ['clamping Interrupt hook timeout to 3s in /<session-flags>/config.toml'] : ['unrelated warning in /home/hooks.json'];
const reply = (id, body) => console.log(JSON.stringify({ jsonrpc: '2.0', id, ...body }));
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (mode === 'hang') return;
  if (message.method === 'initialize') reply(message.id, { result: {} });
  if (message.method !== 'hooks/list') return;
  if (mode === 'old') reply(message.id, { error: { code: -32601, message: 'unknown method' } });
  else reply(message.id, { result: { data: [{ cwd: message.params.cwds[0], hooks: [user, ...hooks], warnings, errors: [] }] } });
});
`;

const SESSION = '/<session-flags>/config.toml';

describe.skipIf(process.platform === 'win32')('createCodexHookArgs', () => {
  let dir: string;
  let codex: string;
  const set = (name: string, value: string) => fs.writeFileSync(path.join(dir, name), value);
  const calls = () => fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n');
  const hookArgs = (timeoutMs?: number) =>
    createCodexHookArgs({ hookScriptPath: '/data/codex-hook.sh', timeoutMs });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-trust-'));
    codex = path.join(dir, 'codex');
    fs.writeFileSync(codex, FAKE_CODEX, { mode: 0o755 });
    set('version', '0.167.0');
    set('mode', 'ok');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns the hook flags with a trust entry for every hook Codex listed', async () => {
    const args = await hookArgs()(codex, process.env);
    expect(args.filter((_, i) => i % 2 === 0)).toEqual(Array<string>(7).fill('-c'));
    expect(args[1]).toBe(
      `hooks.UserPromptSubmit=[{hooks=[{type="command",command="/bin/sh '/data/codex-hook.sh'",timeout=10}]}]`,
    );
    const trust = args[13];
    expect(trust).toContain(
      `"${SESSION}:user_prompt_submit:0:0"={trusted_hash="sha256:UserPromptSubmit0.167.0"}`,
    );
    expect(trust).toContain(`"${SESSION}:interrupt:0:0"={trusted_hash="sha256:Interrupt0.167.0"}`);
    // The user's own hooks are theirs to review.
    expect(trust).not.toContain('sha256:user');
  });

  it('asks Codex once per version, however many agents launch', async () => {
    const resolve = hookArgs();
    const [first, second] = await Promise.all([
      resolve(codex, process.env),
      resolve(codex, process.env),
    ]);
    expect(second).toEqual(first);
    await resolve(codex, process.env);
    expect(calls().filter((call) => call === 'app-server')).toHaveLength(2);

    set('version', '0.168.0');
    const upgraded = await resolve(codex, process.env);
    expect(upgraded[13]).toContain('sha256:Stop0.168.0');
    expect(calls().filter((call) => call === 'app-server')).toHaveLength(4);
  });

  it.each([
    ['does not accept the trust entries', 'untrusted'],
    ['does not list every hook', 'missing'],
    ['warns about the flags', 'warns'],
    ['has no hook listing', 'old'],
  ])('passes no flags when Codex %s', async (_, mode) => {
    set('mode', mode);
    expect(await hookArgs()(codex, process.env)).toEqual([]);
  });

  it('gives up on a Codex that does not answer', async () => {
    set('mode', 'hang');
    expect(await hookArgs(200)(codex, process.env)).toEqual([]);
  });

  it('asks a Codex that failed again after a minute, not on every launch', async () => {
    let clock = 0;
    const resolve = createCodexHookArgs({
      hookScriptPath: '/data/codex-hook.sh',
      now: () => clock,
    });
    set('mode', 'old');
    expect(await resolve(codex, process.env)).toEqual([]);

    set('mode', 'ok');
    clock = 59_000;
    expect(await resolve(codex, process.env)).toEqual([]);
    expect(calls().filter((call) => call === 'app-server')).toHaveLength(1);

    clock = 61_000;
    expect(await resolve(codex, process.env)).toHaveLength(14);
  });

  it('passes no flags on Windows, without asking Codex', async () => {
    const resolve = createCodexHookArgs({ hookScriptPath: '/data/hook.sh', platform: 'win32' });
    expect(await resolve(codex, process.env)).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'calls'))).toBe(false);
  });

  it('passes no flags when the command cannot run', async () => {
    expect(await hookArgs()(path.join(dir, 'missing'), process.env)).toEqual([]);
  });
});
