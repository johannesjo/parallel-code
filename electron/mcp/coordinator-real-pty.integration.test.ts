import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Coordinator } from './coordinator.js';
import type { Notify } from '../ipc/notify.js';

const RUN_REAL_PTY = process.env.RUN_COORDINATOR_PTY_TEST === '1';
const describeRealPty = RUN_REAL_PTY ? describe : describe.skip;
const fakeAgentSource = fileURLToPath(new URL('../../scripts/fake-agent.mjs', import.meta.url));

interface CaptureRecord {
  profile: string;
  payload: string;
  at: number;
}

const ignoreNotifications: Notify = () => undefined;

function runGit(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function createRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'parallel-code-real-pty-repo-'));
  runGit(repo, ['init']);
  runGit(repo, ['checkout', '-b', 'main']);
  runGit(repo, ['config', 'user.email', 'parallel-code-test@example.com']);
  runGit(repo, ['config', 'user.name', 'Parallel Code Test']);
  writeFileSync(join(repo, 'README.md'), '# test repo\n');
  runGit(repo, ['add', 'README.md']);
  runGit(repo, ['commit', '-m', 'initial']);
  return repo;
}

function createFakeCommand(root: string, profile: string): string {
  const binDir = join(root, '.fake-bin');
  mkdirSync(binDir, { recursive: true });
  const command = join(binDir, `fake-${profile}-agent`);
  copyFileSync(fakeAgentSource, command);
  chmodSync(command, 0o755);
  return command;
}

function readCapture(capturePath: string): CaptureRecord[] {
  if (!existsSync(capturePath)) return [];
  return readFileSync(capturePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CaptureRecord);
}

async function expectPromptDeliveredOnce(params: {
  profile: string;
  extraArgs?: string[];
  promptSuffix?: string;
}): Promise<void> {
  const repo = createRepo();
  const capturePath = join(
    repo,
    '.captures',
    `${params.profile}${params.promptSuffix ?? ''}.jsonl`,
  );
  const command = createFakeCommand(repo, params.profile);
  const coordinator = new Coordinator();
  let taskId: string | undefined;
  const assignment = `Do the ${params.profile}${params.promptSuffix ?? ''} startup assignment.`;

  try {
    coordinator.setNotify(ignoreNotifications);
    coordinator.setDefaultProject('proj-1', repo);
    coordinator.registerCoordinator('coord-1', 'proj-1', {
      branchName: 'main',
      worktreePath: repo,
    });
    coordinator.setCoordinatorSpawnDefaults('coord-1', command, [
      '--profile',
      params.profile,
      '--capture',
      capturePath,
      ...(params.extraArgs ?? []),
    ]);

    const task = await coordinator.createTask({
      name: `${params.profile} startup delivery`,
      prompt: assignment,
      coordinatorTaskId: 'coord-1',
    });
    taskId = task.id;

    const records = await waitForCapture(
      capturePath,
      (items) => items.filter((item) => item.payload.includes(assignment)).length === 1,
    );
    const matching = records.filter((item) => item.payload.includes(assignment));

    expect(matching).toHaveLength(1);
    expect(matching[0].profile).toBe(params.profile);
    expect(matching[0].payload).toMatch(/\[SUB-TASK MODE]|<sub-task-mode>/);

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(
      readCapture(capturePath).filter((item) => item.payload.includes(assignment)),
    ).toHaveLength(1);
  } finally {
    if (taskId) {
      await coordinator.closeTask(taskId).catch(() => undefined);
    }
    rmSync(dirname(capturePath), { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
}

async function waitForCapture(
  capturePath: string,
  predicate: (records: CaptureRecord[]) => boolean,
  timeoutMs = 8_000,
): Promise<CaptureRecord[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const records = readCapture(capturePath);
    if (predicate(records)) return records;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return readCapture(capturePath);
}

describeRealPty('Coordinator real PTY initial prompt delivery', () => {
  it.each(['codex', 'claude', 'gemini', 'copilot'])(
    'sends a new coordinated task assignment to a fake %s agent exactly once',
    async (profile) => {
      await expectPromptDeliveredOnce({ profile });
    },
    15_000,
  );

  it.each(['codex', 'claude', 'gemini', 'copilot'])(
    'sends to fake %s exactly once when startup redraw evicts the prompt marker',
    async (profile) => {
      await expectPromptDeliveredOnce({
        profile,
        extraArgs: ['--transient-ready'],
        promptSuffix: '-transient',
      });
    },
    15_000,
  );

  it('waits long enough for a fake Claude paste to settle before submitting', async () => {
    await expectPromptDeliveredOnce({
      profile: 'claude',
      extraArgs: ['--bracketed-paste', '--min-enter-delay-ms', '200'],
      promptSuffix: '-settled-paste',
    });
  }, 15_000);
});
