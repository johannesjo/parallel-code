# Qoder CLI Built-in Agent (Terminal Parity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Qoder CLI a built-in agent with Claude Code's terminal-level support: sessions, status hooks, MCP arguments, skip permissions and resume.

**Architecture:** Register `qoder` in the built-in agent table, teach the shared session/skip-permission tables about its flags, and route it through the existing `--settings` hook pipeline using the hooks-only settings file. The renderer launch builder recognises Qoder where it already special-cases Claude. No IPC channels or chat providers change.

**Tech Stack:** TypeScript (strict), SolidJS renderer, Electron main process, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-qoder-agent-parity-design.md`

**Tracking issue:** https://github.com/oraclebox/parallel-code/issues/2

## Global Constraints

- npm only; CI runs Node.js 22.
- Strict TypeScript; no `any`, no non-null assertions (lint treats warnings as failures).
- Electron relative imports use `.js` suffixes (NodeNext resolution).
- Conventional commit messages, e.g. `feat(agents): add Qoder CLI`.
- Do not change the preload allowlist or add IPC channels.
- Vitest auto-selects its compact reporter; never pass `--reporter`.
- Qoder flags verified against Qoder CLI 1.1.93: `--continue`, `--resume [id]`, `--session-id`, `--settings`, `--mcp-config`, `--dangerously-skip-permissions`, `--permission-mode`.
- `--permission-mode dont_ask` is not a bypass (it denies anything that would ask); only `bypass_permissions` / `yolo` / `YOLO` / `--yolo` are bypasses.

## Review Focus

- A user-supplied `--settings` on a Qoder launch must be preserved; the app must not stack a second one.
- A wrapper whose basename is not exactly `qoder` (e.g. `my-qoder`) must keep generic handling: no session flags, no hooks.
- A Qoder launch in Docker or a shell pane must receive no loopback hook settings or hook env.
- A shared-checkout (hidden) task resuming Qoder with `--continue` must open the picker instead of continuing another pane's session.
- `--permission-mode dont_ask` and `accept_edits` must survive skip-permission stripping; only `bypass_permissions` / `yolo` are removed.

---

### Task 1: Teach the shared launch tables about Qoder

**Files:**

- Modify: `electron/shared/skip-permissions.ts`
- Modify: `electron/shared/session-resume.ts`
- Test: `electron/shared/skip-permissions.test.ts`
- Test: `electron/shared/session-resume.test.ts`
- Create: `src/store/session-ids.test.ts`

**Interfaces:**

- Produces: `getSkipPermissionsArgs('qoder') -> ['--dangerously-skip-permissions']`.
- Produces: `newSessionArgs('qoder', id) -> ['--session-id', id]`; `resumeSessionArgs('qoder', id) -> ['--resume', id]`.
- Produces: `canAssignSessionId('qoder') -> true`; `canResumeSessionId('qoder') -> true`.

- [ ] **Step 1: Write the failing shared-table tests**

In `electron/shared/skip-permissions.test.ts`, extend the built-in flag assertion and add bypass cases:

```ts
expect(getSkipPermissionsArgs('qoder')).toEqual(['--dangerously-skip-permissions']);
```

```ts
it('treats Qoder bypass modes as dangerous but keeps narrower modes', () => {
  expect(stripPermissionBypassArgs('qoder', ['--yolo', '--model', 'lite'])).toEqual([
    '--model',
    'lite',
  ]);
  expect(stripPermissionBypassArgs('qoder', ['--permission-mode', 'bypass_permissions'])).toEqual(
    [],
  );
  expect(stripPermissionBypassArgs('qoder', ['--permission-mode', 'dont_ask'])).toEqual([
    '--permission-mode',
    'dont_ask',
  ]);
  expect(stripPermissionBypassArgs('qoder', ['--permission-mode', 'accept_edits'])).toEqual([
    '--permission-mode',
    'accept_edits',
  ]);
});
```

In `electron/shared/session-resume.test.ts`, add:

```ts
it('names and resumes a Qoder session', () => {
  expect(newSessionArgs('qoder', ID)).toEqual(['--session-id', ID]);
  expect(resumeSessionArgs('qoder', ID)).toEqual(['--resume', ID]);
  expect(canAssignSessionId('qoder')).toBe(true);
  expect(canResumeSessionId('qoder')).toBe(true);
});
```

Create `src/store/session-ids.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assignFreshSessionId } from './session-ids';

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('assignFreshSessionId', () => {
  it('gives a Qoder pane an id of its own', () => {
    const draft: { tasks: Record<string, { agentSessionIds?: Record<string, string> }> } = {
      tasks: { t: {} },
    };
    assignFreshSessionId(draft, 't', 'a', 'qoder');
    expect(draft.tasks.t.agentSessionIds?.a).toMatch(ID_RE);
  });

  it('clears the id for an agent that cannot mint one', () => {
    const draft: { tasks: Record<string, { agentSessionIds?: Record<string, string> }> } = {
      tasks: { t: { agentSessionIds: { a: 'old' } } },
    };
    assignFreshSessionId(draft, 't', 'a', 'opencode');
    expect(draft.tasks.t.agentSessionIds).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:unit -- electron/shared/skip-permissions.test.ts electron/shared/session-resume.test.ts src/store/session-ids.test.ts`
Expected: FAIL — Qoder returns no skip args, null session args, and `false` capabilities.

- [ ] **Step 3: Implement the shared-table changes**

In `electron/shared/skip-permissions.ts`:

- Add `['qoder', ['--dangerously-skip-permissions']]` to `SKIP_PERMISSIONS_ARGS`.
- Add a `BYPASS_RULES` entry keyed `qoder` with flags `['--dangerously-skip-permissions', '--yolo']` and `valued` map `['--permission-mode', oneOf('bypass_permissions', 'bypassPermissions', 'yolo', 'YOLO')]`.

In `electron/shared/session-resume.ts`:

- Add `function isQoder(command: string): boolean { return commandName(command) === 'qoder'; }`.
- `newSessionArgs`: `qoder -> ['--session-id', sessionId]`.
- `resumeSessionArgs`: `qoder -> ['--resume', sessionId]`.
- Add `isQoder` to `canAssignSessionId` and `canResumeSessionId`.
- Update the doc comment that says only Claude can be handed an id.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:unit -- electron/shared/skip-permissions.test.ts electron/shared/session-resume.test.ts src/store/session-ids.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck the touched modules**

Run: `npm run typecheck:electron`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add electron/shared/skip-permissions.ts electron/shared/session-resume.ts \
  electron/shared/skip-permissions.test.ts electron/shared/session-resume.test.ts \
  src/store/session-ids.test.ts
git commit -m "feat(agents): recognise Qoder sessions and permissions"
```

---

### Task 2: Report Qoder status through the hook pipeline

**Files:**

- Modify: `electron/agent-hooks/launch-args.ts`
- Modify: `electron/agent-hooks/server.ts`
- Modify: `electron/agent-hooks/runtime.ts`
- Modify: `electron/ipc/pty.ts`
- Test: `electron/agent-hooks/launch-args.test.ts`
- Test: `electron/agent-hooks/server.test.ts`
- Test: `electron/ipc/pty.test.ts`

**Interfaces:**

- Consumes: nothing from Task 1.
- Produces: `isQoderCommand(command: string): boolean` from `launch-args.ts`.
- Produces: `withQoderHookSettings(command: string, args: readonly string[], settingsPath: string): string[]`.
- Produces: `AgentHookServer.qoderSettingsPath: string` and `AgentHookRuntime.qoderSettingsPath: string`; both point at the hooks-only settings JSON.

- [ ] **Step 1: Write the failing hook tests**

In `electron/agent-hooks/launch-args.test.ts`, extend the existing import with
`isQoderCommand` and `withQoderHookSettings`, then add:

```ts
it('appends --settings for qoder and respects the user-supplied flag', () => {
  expect(withQoderHookSettings('qoder', ['--continue'], '/q.json')).toEqual([
    '--continue',
    '--settings',
    '/q.json',
  ]);
  expect(withQoderHookSettings('/usr/local/bin/qoder', [], '/q.json')).toEqual([
    '--settings',
    '/q.json',
  ]);
  expect(withQoderHookSettings('qoder', ['--settings', '/mine.json'], '/q.json')).toEqual([
    '--settings',
    '/mine.json',
  ]);
});

it('leaves a differently named Qoder wrapper alone', () => {
  expect(withQoderHookSettings('my-qoder', [], '/q.json')).toEqual([]);
  expect(isQoderCommand('my-qoder')).toBe(false);
});
```

In `electron/agent-hooks/server.test.ts`:

```ts
it('exposes a hooks-only settings file for Qoder', () => {
  const settings = JSON.parse(fs.readFileSync(server.qoderSettingsPath, 'utf8'));
  expect(settings.hooks.Stop[0].hooks[0].command).toContain(server.hookScriptPath);
  expect(settings).not.toHaveProperty('statusLine');
});
```

In `electron/ipc/pty.test.ts`, add `qoderSettingsPath: '/qoder-hook-settings.json'` to both existing runtime mocks (around lines 938 and 971), then add:

```ts
it('launches Qoder with the hooks-only settings and hook identity', async () => {
  setAgentHookRuntime({
    claudeSettingsPath: () => '/hook-settings.json',
    qoderSettingsPath: '/qoder-hook-settings.json',
    buildPtyEnv: (id) => ({ PARALLEL_CODE_AGENT_ID: id }),
    codexHookArgs: () => Promise.resolve([]),
  });
  await spawnAgent(
    createMockNotify(),
    buildSpawnArgs({ agentId: 'agent-qoder-hooks', command: 'qoder', args: [], dockerMode: false }),
  );
  expect(lastSpawn().args).toEqual(['--settings', '/qoder-hook-settings.json']);
  expect(lastSpawn().env.PARALLEL_CODE_AGENT_ID).toBe('agent-qoder-hooks');
});

it('gives shell and Docker Qoder launches no hook settings', () => {
  setAgentHookRuntime({
    claudeSettingsPath: () => '/hook-settings.json',
    qoderSettingsPath: '/qoder-hook-settings.json',
    buildPtyEnv: (id) => ({ PARALLEL_CODE_AGENT_ID: id }),
    codexHookArgs: () => Promise.resolve([]),
  });
  for (const mode of [
    { isShell: true, dockerMode: false },
    { isShell: false, dockerMode: true },
  ]) {
    const env: Record<string, string> = {};
    const args = applyAgentHookLaunch(
      { agentId: 'agent-qoder-excluded', taskId: 't', args: ['--continue'], ...mode },
      'qoder',
      '/work',
      env,
      'launch-1',
    );
    expect(args).toEqual(['--continue']);
    expect(env.PARALLEL_CODE_AGENT_ID).toBeUndefined();
  }
});
```

Import `applyAgentHookLaunch` from `./pty` alongside the test's existing imports.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:unit -- electron/agent-hooks/launch-args.test.ts electron/agent-hooks/server.test.ts electron/ipc/pty.test.ts`
Expected: FAIL — `isQoderCommand`/`withQoderHookSettings` missing, `qoderSettingsPath` not on the server, and the Qoder launch has no `--settings`.

- [ ] **Step 3: Implement the hook pipeline changes**

In `electron/agent-hooks/launch-args.ts`:

- Add `isQoderCommand` using `path.basename(command) === 'qoder'`.
- Extract the current `--settings` guard into `function withSettingsArg(args: readonly string[], settingsPath: string): string[]` and make `withClaudeHookSettings` call it only for Claude.
- Add `withQoderHookSettings(command, args, settingsPath)` that calls `withSettingsArg` only when `isQoderCommand(command)`.

In `electron/agent-hooks/server.ts`:

- Add `qoderSettingsPath: string` to `AgentHookServer` with a comment: hooks-only, no status line.
- In the resolved object from `startAgentHookServer`, set `qoderSettingsPath: files.hooksOnlySettingsPath`.

In `electron/agent-hooks/runtime.ts`:

- Pass `qoderSettingsPath: server.qoderSettingsPath` in `setAgentHookRuntime`.

In `electron/ipc/pty.ts`:

- Import `isQoderCommand` and `withQoderHookSettings`.
- Add `qoderSettingsPath: string` to `AgentHookRuntime`.
- In `applyAgentHookLaunch`, keep the existing early return for no runtime, shell and Docker. Then branch: Claude uses `claudeSettingsPath` and `withClaudeHookSettings`; Qoder uses `qoderSettingsPath` and `withQoderHookSettings`; every other command returns `args.args` unchanged. Inject `buildPtyEnv` before either branch.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:unit -- electron/agent-hooks/launch-args.test.ts electron/agent-hooks/server.test.ts electron/ipc/pty.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck the Electron backend**

Run: `npm run typecheck:electron`
Expected: PASS. Every mock of `AgentHookRuntime` must now provide `qoderSettingsPath`; fix any the compiler reports.

- [ ] **Step 6: Commit**

```bash
git add electron/agent-hooks/launch-args.ts electron/agent-hooks/server.ts \
  electron/agent-hooks/runtime.ts electron/ipc/pty.ts \
  electron/agent-hooks/launch-args.test.ts electron/agent-hooks/server.test.ts electron/ipc/pty.test.ts
git commit -m "feat(agent-hooks): report Qoder status through hooks"
```

---

### Task 3: Build Qoder launch arguments in the renderer

**Files:**

- Modify: `src/lib/agent-args.ts`
- Test: `src/lib/agent-args.test.ts`
- Test: `electron/mcp/agent-args.test.ts`

**Interfaces:**

- Consumes: Task 1's `session-resume` behaviour and Task 1's skip-permission table.
- Produces: `buildTaskAgentArgs` accepts a Qoder `AgentDef` (`command: 'qoder'`, `resume_args: ['--continue']`) and emits `--session-id`, `--resume`, `--dangerously-skip-permissions` and `--mcp-config` as appropriate.
- Produces: `taskAgentOpensSessionPicker` returns `true` for a shared-checkout Qoder launch.

- [ ] **Step 1: Write the failing renderer and MCP tests**

In `src/lib/agent-args.test.ts`, add the fixture and cases:

```ts
const qoderAgent = {
  id: 'qoder',
  name: 'Qoder',
  description: 'Qoder agent',
  command: 'qoder',
  args: [],
  resume_args: ['--continue'],
  skip_permissions_args: ['--dangerously-skip-permissions'],
};

it('names and resumes a Qoder session by id', () => {
  const SESSION = 'fb4f2bc6-62d9-4b29-a795-240caf2fc459';
  expect(buildTaskAgentArgs(qoderAgent, {}, false, undefined, SESSION)).toEqual([
    '--session-id',
    SESSION,
  ]);
  expect(buildTaskAgentArgs(qoderAgent, {}, true, undefined, SESSION)).toEqual([
    '--resume',
    SESSION,
  ]);
});

it('opens the Qoder picker for a shared-checkout task', () => {
  expect(buildTaskAgentArgs(qoderAgent, { id: 'doc-agent-docs' }, true)).toEqual(['--resume']);
  expect(taskAgentOpensSessionPicker(qoderAgent, { id: 'doc-agent-docs' }, true)).toBe(true);
});

it('keeps the Qoder MCP and skip-permission fallbacks', () => {
  expect(
    buildTaskAgentArgs(
      qoderAgent,
      { skipPermissions: true, mcpConfigPath: '/tmp/mcp.json' },
      false,
    ),
  ).toEqual(['--dangerously-skip-permissions', '--mcp-config', '/tmp/mcp.json']);
});
```

In `electron/mcp/agent-args.test.ts`:

```ts
it('uses --mcp-config for Qoder', () => {
  expect(buildMcpLaunchArgs('qoder', '/tmp/config.json', config)).toEqual([
    '--mcp-config',
    '/tmp/config.json',
  ]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:unit -- src/lib/agent-args.test.ts electron/mcp/agent-args.test.ts`
Expected: FAIL — the shared-checkout Qoder launch still emits `--continue`, and the picker returns `false`. The session-id, MCP and skip-permission assertions may already pass because Task 1 handles them.

- [ ] **Step 3: Implement the renderer changes**

In `src/lib/agent-args.ts`:

- In `positionalAgentArgs`, include `qoder` in the shared-checkout rewrite: `(command === 'claude' || command === 'copilot' || command === 'qoder') && resume === '--continue'` becomes `['--resume']`.
- In `taskAgentOpensSessionPicker`, set the selector to `'--resume'` for `claude` or `qoder`.
- Leave `legacyMcpConfigArgs` and `RESUME_FAILURE_PATTERNS` unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:unit -- src/lib/agent-args.test.ts electron/mcp/agent-args.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck the renderer**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent-args.ts src/lib/agent-args.test.ts electron/mcp/agent-args.test.ts
git commit -m "feat(agents): build Qoder launch arguments"
```

---

### Task 4: Register Qoder and document the support

**Files:**

- Modify: `electron/ipc/agents.ts`
- Modify: `README.md:64`, `README.md:98`
- Modify: `docs/custom-agents.md:3`, `docs/custom-agents.md:43-48`

**Interfaces:**

- Consumes: Task 1's skip-permission table (the agent entry leaves `skip_permissions_args` to `getSkipPermissionsArgs`).
- Produces: a built-in `AgentDef` with `id: 'qoder'`, `name: 'Qoder CLI'`, `command: 'qoder'`, `args: []`, `resume_args: ['--continue']`, `description: 'Qoder CLI agent'`.

- [ ] **Step 1: Add the built-in agent entry**

In `electron/ipc/agents.ts`, append to `DEFAULT_AGENTS` after Antigravity:

```ts
{
  id: 'qoder',
  name: 'Qoder CLI',
  command: 'qoder',
  args: [],
  resume_args: ['--continue'],
  skip_permissions_args: getSkipPermissionsArgs('qoder'),
  description: 'Qoder CLI agent',
},
```

- [ ] **Step 2: Update the documentation**

In `README.md`, add Qoder to both agent lists (line 64 and line 98). Use the wording already there, e.g. `[Qoder CLI](https://qoder.com/cli)`.

In `docs/custom-agents.md`:

- Line 3: add Qoder CLI to the built-in list.
- Status paragraph: say status is precise for Claude Code, Codex and Qoder; other agents use terminal heuristics.
- Command-recognition paragraph: `qoder` gets Claude Code-compatible status hooks, session IDs and `--mcp-config`, and a default skip-permissions flag.
- Keep the existing notes that AI features and the chat view stay Claude/Codex/MiniMax, and that Docker keeps terminal-heuristic status.

- [ ] **Step 3: Verify the app shows the agent**

Run: `npm run dev`
Expected: Settings → Agents lists `Qoder CLI`; New task offers it when `which qoder` succeeds. Stop the app afterwards. If this environment has no display, record the app-start check as not run and continue.

- [ ] **Step 4: Run static checks**

Run: `npm run check`
Expected: PASS (typecheck, lint, formatting).

- [ ] **Step 5: Commit**

```bash
git add electron/ipc/agents.ts README.md docs/custom-agents.md
git commit -m "feat(agents): add Qoder CLI as a built-in agent"
```

---

### Task 5: End-to-end verification

**Files:**

- None expected. If a check fails, fix the owning file and commit the fix with a conventional message.

**Interfaces:**

- Consumes: every prior task.

- [ ] **Step 1: Run the affected suites**

Run: `npm run test:changed`
Expected: PASS.

- [ ] **Step 2: Run the full static gate**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 3: Manual smoke with the installed Qoder CLI**

Start `npm run dev`, then:

1. Create a task with agent `Qoder CLI` and the prompt `list the files here`.
2. Confirm the prompt is typed automatically and the card moves to Working, then leaves Working when the turn ends; a question moves it to Needs you. If the prompt is typed before Qoder's input is ready, or lands on an init dialog, add `prompt_ready_delay_ms` to the `qoder` entry in `electron/ipc/agents.ts` with the measured delay, retest, and commit the adjustment.
3. Quit and reopen the app; the task resumes the same conversation.
4. Start a task with Skip permissions ticked; tool calls do not prompt.
5. Run a coordinated task and confirm the launch accepts `--mcp-config`.
6. Start a Qoder task in Docker; status falls back to terminal heuristics without errors.

Record any step that could not be run (no display, no Docker, no login) instead of claiming success.

- [ ] **Step 4: Report**

Summarise the commands run, their results, and skipped manual checks. Do not commit when there are no changes.
