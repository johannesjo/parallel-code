import { For, Show, createSignal, createEffect, onCleanup } from 'solid-js';
import { TerminalView } from '../components/TerminalView';
import { ChangedFilesList } from '../components/ChangedFilesList';
import { DiffViewerDialog } from '../components/DiffViewerDialog';
import { fireAndForget } from '../lib/ipc';
import { showNotification } from '../store/notification';
import { IPC } from '../../electron/ipc/channels';
import {
  arenaStore,
  markBattleCompetitorExited,
  allBattleFinished,
  setPhase,
  setTerminalOutput,
} from './store';
import { formatDuration } from './utils';

/** Format elapsed ms for a live timer — whole seconds above 60s to avoid jitter */
function formatElapsed(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return formatDuration(ms);
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}m ${secs}s`;
}

/** Replace {prompt} in the command template with the escaped prompt.
 *  The template uses double-quote context, so escape characters meaningful
 *  inside double quotes: ", $, `, and \. Note: ! (history expansion) is a
 *  bash-only feature and not special in POSIX /bin/sh double quotes. */
function buildCommand(template: string, prompt: string): { command: string; args: string[] } {
  const escapedPrompt = prompt
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');
  const fullCommand = template.replace(/\{prompt\}/g, escapedPrompt);
  return { command: '/bin/sh', args: ['-c', fullCommand] };
}

export function BattleScreen() {
  const [elapsed, setElapsed] = createSignal<Record<string, number>>({});
  const [diffScrollTarget, setDiffScrollTarget] = createSignal<string | null>(null);
  const [diffWorktree, setDiffWorktree] = createSignal('');

  // Store buffer serializers keyed by competitor id
  const bufferSerializers = new Map<string, () => string>();

  // Tick every 100ms to update running timers
  const timer = setInterval(() => {
    const now = Date.now();
    const next: Record<string, number> = {};
    for (const c of arenaStore.battle) {
      if (c.status === 'running') {
        next[c.agentId] = now - c.startTime;
      } else if (c.endTime !== null) {
        next[c.agentId] = c.endTime - c.startTime;
      }
    }
    setElapsed(next);
  }, 100);
  onCleanup(() => clearInterval(timer));

  // Auto-transition to results when all competitors finish
  createEffect(() => {
    if (!allBattleFinished()) return;
    const timeout = setTimeout(() => {
      // Capture terminal output before transitioning (terminals get disposed on unmount)
      for (const c of arenaStore.battle) {
        const getBuffer = bufferSerializers.get(c.id);
        if (getBuffer) setTerminalOutput(c.id, getBuffer());
      }
      setPhase('results');
    }, 1500);
    onCleanup(() => clearTimeout(timeout));
  });

  function handleStop(agentId: string) {
    fireAndForget(IPC.KillAgent, { agentId }, () => {
      showNotification('Failed to stop agent');
    });
  }

  function handleFileClick(worktreePath: string, filePath: string) {
    setDiffWorktree(worktreePath);
    setDiffScrollTarget(filePath);
  }

  return (
    <>
      <div class="arena-battle">
        <For each={arenaStore.battle}>
          {(competitor, index) => {
            const { command, args } = buildCommand(competitor.command, arenaStore.prompt);
            const agentId = competitor.agentId;
            const cwd = competitor.worktreePath ?? '/tmp';

            return (
              <>
                <Show when={index() > 0}>
                  <div class="arena-vs-badge">VS</div>
                </Show>
                <div class="arena-battle-panel" data-arena={index()}>
                  <div class="arena-battle-panel-header">
                    <span class="arena-battle-panel-name">{competitor.name}</span>
                    <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                      <span
                        class="arena-battle-panel-timer"
                        data-done={competitor.status === 'exited' ? 'true' : undefined}
                      >
                        {formatElapsed(elapsed()[agentId] ?? 0)}
                      </span>
                      <Show when={competitor.status === 'running'}>
                        <button
                          class="arena-stop-btn"
                          onClick={() => handleStop(agentId)}
                          title="Stop"
                        >
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                            <rect x="3" y="3" width="10" height="10" rx="1" />
                          </svg>
                        </button>
                      </Show>
                    </div>
                  </div>
                  <div style={{ flex: '1', overflow: 'hidden' }}>
                    <TerminalView
                      taskId={competitor.id}
                      agentId={agentId}
                      command={command}
                      args={args}
                      cwd={cwd}
                      onExit={(info) => markBattleCompetitorExited(agentId, info.exit_code)}
                      onBufferReady={(getBuffer) => bufferSerializers.set(competitor.id, getBuffer)}
                    />
                  </div>
                  <Show when={competitor.worktreePath}>
                    <div class="arena-battle-panel-files">
                      <ChangedFilesList
                        worktreePath={cwd}
                        isActive={true}
                        onFileClick={(file) => handleFileClick(cwd, file.path)}
                      />
                    </div>
                  </Show>
                </div>
              </>
            );
          }}
        </For>
      </div>
      <DiffViewerDialog
        scrollToFile={diffScrollTarget()}
        worktreePath={diffWorktree()}
        onClose={() => setDiffScrollTarget(null)}
      />
    </>
  );
}
