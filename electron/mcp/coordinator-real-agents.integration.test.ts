import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { Coordinator } from './coordinator.js';
import type { Notify } from '../ipc/notify.js';
import { writeToAgent } from '../ipc/pty.js';

const RUN_REAL_AGENT_SMOKE = process.env.RUN_REAL_AGENT_SMOKE === '1';
// Dangerous flags (--dangerously-bypass-approvals-and-sandbox, --dangerously-skip-permissions)
// run agents with no sandbox on the host machine. Require a second opt-in to avoid accidental
// credential exposure on dev machines running with credentials in scope.
const RUN_REAL_AGENT_DANGEROUS = process.env.RUN_REAL_AGENT_DANGEROUS === '1';
const RUN_REAL_AGENT_HOST_HOME = process.env.RUN_REAL_AGENT_HOST_HOME === '1';
const describeRealAgents =
  RUN_REAL_AGENT_SMOKE && RUN_REAL_AGENT_DANGEROUS ? describe : describe.skip;
const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

interface RealAgentProfile {
  name: 'codex' | 'claude' | 'gemini';
  command: string;
  args: string[];
}

interface RendererEvent {
  channel: string;
  payload: unknown;
}

function createMockNotify(events: RendererEvent[]): Notify {
  return (channel, payload) => {
    events.push({ channel, payload });
  };
}

function runGit(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function createRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'parallel-code-real-agent-repo-'));
  runGit(repo, ['init']);
  runGit(repo, ['checkout', '-b', 'main']);
  runGit(repo, ['config', 'user.email', 'parallel-code-test@example.com']);
  runGit(repo, ['config', 'user.name', 'Parallel Code Test']);
  writeFileSync(join(repo, 'README.md'), '# real agent smoke\n');
  runGit(repo, ['add', 'README.md']);
  runGit(repo, ['commit', '-m', 'initial']);
  return repo;
}

function which(command: string): string | null {
  try {
    return execFileSync('which', [command], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function realAgentProfiles(): RealAgentProfile[] {
  const profiles: RealAgentProfile[] = [];
  const codex = which('codex');
  if (codex) {
    profiles.push({
      name: 'codex',
      command: codex,
      args: ['--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen'],
    });
  }

  const claude = which('claude');
  if (claude) {
    profiles.push({
      name: 'claude',
      command: claude,
      args: ['--dangerously-skip-permissions'],
    });
  }

  const gemini = which('gemini');
  if (gemini) {
    profiles.push({
      name: 'gemini',
      command: gemini,
      args: [
        '--skip-trust',
        '--prompt-interactive',
        'Do not edit files. Wait for the next user instruction.',
      ],
    });
  }

  return profiles;
}

async function waitForInitialPromptDelivery(
  events: RendererEvent[],
  taskId: string,
  coordinator: Coordinator,
  timeoutMs = 90_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const delivered = events.some((event) => {
      if (event.channel !== 'mcp_task_state_sync') return false;
      const payload = event.payload as { taskId?: string; initialPrompt?: string | null };
      return payload.taskId === taskId && payload.initialPrompt === null;
    });
    if (delivered) return;
    const status = coordinator.getTaskStatus(taskId);
    if (status?.status === 'exited' || status?.status === 'error') {
      throw new Error(
        `Task exited before initial prompt delivery. Last output:\n${coordinator.getTaskOutput(taskId)?.slice(-2048) ?? ''}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const status = coordinator.getTaskStatus(taskId);
  throw new Error(
    [
      `Timed out waiting for initial prompt delivery to ${taskId}`,
      `Last status: ${JSON.stringify(status)}`,
      'Last output:',
      coordinator.getTaskOutput(taskId)?.slice(-4096) ?? '',
    ].join('\n'),
  );
}

async function acceptStartupTrustDialogIfPresent(
  coordinator: Coordinator,
  taskId: string,
  agentId: string,
  timeoutMs = 20_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const output = coordinator.getTaskOutput(taskId) ?? '';
    if (
      /\bDo\s*you\s*trust\b|\bPress\s*enter\s*to\s*continue\b|\btrust\s*this\s*folder\b/i.test(
        output,
      )
    ) {
      writeToAgent(agentId, '\r');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describeRealAgents('Coordinator real agent startup smoke', () => {
  it.each(realAgentProfiles())(
    'delivers an initial prompt to installed $name',
    async ({ name, command, args }) => {
      const repo = RUN_REAL_AGENT_HOST_HOME ? projectRoot : createRepo();
      const coordinator = new Coordinator();
      const rendererEvents: RendererEvent[] = [];
      let taskId: string | undefined;
      const token = `PARALLEL_CODE_REAL_AGENT_SMOKE_${name.toUpperCase()}`;

      // Isolate spawned CLIs from host dotfiles/credentials unless explicitly testing
      // authenticated local agent profiles.
      const tempHome = RUN_REAL_AGENT_HOST_HOME
        ? undefined
        : mkdtempSync(join(tmpdir(), 'parallel-code-test-home-'));
      const origHome = process.env.HOME;
      if (tempHome) {
        process.env.HOME = tempHome;
      }

      try {
        coordinator.setNotify(createMockNotify(rendererEvents));
        coordinator.setDefaultProject('proj-1', repo);
        coordinator.registerCoordinator('coord-1', 'proj-1', {
          branchName: 'main',
          worktreePath: repo,
        });
        coordinator.setCoordinatorSpawnDefaults('coord-1', command, args);

        const task = await coordinator.createTask({
          name: `${name} real startup smoke`,
          prompt: [
            'This is a Parallel Code startup delivery smoke test.',
            'Do not edit files, run commands, commit, or call tools.',
            `Reply with exactly this token and no extra text: ${token}`,
          ].join(' '),
          coordinatorTaskId: 'coord-1',
        });
        taskId = task.id;

        await acceptStartupTrustDialogIfPresent(coordinator, task.id, task.agentId);
        await waitForInitialPromptDelivery(rendererEvents, task.id, coordinator);

        const status = execFileSync('git', ['status', '--short'], {
          cwd: task.worktreePath,
          encoding: 'utf8',
        });
        const realChanges = status
          .split('\n')
          .filter(Boolean)
          .filter((line) => {
            const filePath = line.slice(3);
            return (
              !['AGENTS.md', 'GEMINI.md'].includes(filePath) && !filePath.startsWith('.claude/')
            );
          });
        expect(realChanges).toEqual([]);
      } finally {
        process.env.HOME = origHome;
        if (taskId) {
          await coordinator.closeTask(taskId).catch(() => undefined);
        }
        if (!RUN_REAL_AGENT_HOST_HOME && existsSync(repo)) {
          rmSync(repo, { recursive: true, force: true });
        }
        if (tempHome) {
          rmSync(tempHome, { recursive: true, force: true });
        }
      }
    },
    120_000,
  );

  it('has at least one installed real agent when enabled', () => {
    expect(realAgentProfiles().length).toBeGreaterThan(0);
  });
});
