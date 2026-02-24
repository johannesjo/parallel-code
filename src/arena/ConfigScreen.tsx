import { For, Show, createSignal } from 'solid-js';
import {
  arenaStore,
  updateCompetitor,
  addCompetitor,
  removeCompetitor,
  setPrompt,
  setCwd,
  canFight,
  startBattle,
  setPhase,
  applyPreset,
  saveCurrentAsPreset,
  deletePreset,
} from './store';
import { store, getProject } from '../store/store';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { saveArenaPresets } from './persistence';
import { ProjectSelect } from '../components/ProjectSelect';
import { MAX_COMPETITORS, MIN_COMPETITORS } from './store';
import type { BattleCompetitor } from './types';

/** Built-in tool presets — click to fill the next empty competitor slot */
const TOOL_PRESETS: Array<{ name: string; command: string }> = [
  { name: 'Claude', command: 'claude -p "{prompt}" --dangerously-skip-permissions' },
  { name: 'Codex', command: 'codex exec --full-auto "{prompt}"' },
  { name: 'Gemini', command: 'gemini -p "{prompt}" --yolo' },
  { name: 'Copilot', command: 'copilot -p "{prompt}" --yolo' },
  { name: 'Aider', command: 'aider -m "{prompt}" --yes' },
  { name: 'OpenCode', command: 'opencode -p "{prompt}"' },
];

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
}

export function ConfigScreen() {
  const [presetName, setPresetName] = createSignal('');
  const [showPresetSave, setShowPresetSave] = createSignal(false);
  const [preparing, setPreparing] = createSignal(false);
  const [fightError, setFightError] = createSignal<string | null>(null);

  async function handleFight() {
    if (!canFight() || preparing()) return;
    setPreparing(true);
    setFightError(null);

    try {
      const filled = arenaStore.competitors.filter(
        (c) => c.name.trim() !== '' && c.command.trim() !== '',
      );
      const projectRoot = arenaStore.cwd;

      const runId = Date.now();
      const competitors: BattleCompetitor[] = await Promise.all(
        filled.map(async (c, i) => {
          let worktreePath: string | null = null;
          let branchName: string | null = null;

          if (projectRoot) {
            branchName = `arena/${slug(c.name)}-${runId}-${i}`;
            const result = await invoke<{ path: string; branch: string }>(IPC.CreateArenaWorktree, {
              projectRoot,
              branchName,
              symlinkDirs: ['node_modules'],
            });
            worktreePath = result.path;
          }

          return {
            id: c.id,
            name: c.name,
            command: c.command,
            agentId: crypto.randomUUID(),
            status: 'running' as const,
            startTime: Date.now(),
            endTime: null,
            exitCode: null,
            worktreePath,
            branchName,
          };
        }),
      );

      startBattle(competitors);
    } catch (e) {
      setFightError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreparing(false);
    }
  }

  function handleToolPreset(tool: { name: string; command: string }) {
    // Fill the first empty competitor slot, or add a new one
    const emptySlot = arenaStore.competitors.find(
      (c) => c.name.trim() === '' && c.command.trim() === '',
    );
    if (emptySlot) {
      updateCompetitor(emptySlot.id, { name: tool.name, command: tool.command });
    } else if (arenaStore.competitors.length < MAX_COMPETITORS) {
      addCompetitor();
      // Fill the newly added slot
      const last = arenaStore.competitors[arenaStore.competitors.length - 1];
      updateCompetitor(last.id, { name: tool.name, command: tool.command });
    }
  }

  function handleSavePreset() {
    const name = presetName().trim();
    if (!name) return;
    saveCurrentAsPreset(name);
    void saveArenaPresets();
    setPresetName('');
    setShowPresetSave(false);
  }

  function handleApplyPreset(preset: {
    id: string;
    name: string;
    competitors: Array<{ name: string; command: string }>;
  }) {
    applyPreset(preset);
  }

  function handleDeletePreset(id: string) {
    deletePreset(id);
    void saveArenaPresets();
  }

  return (
    <div class="arena-config">
      {/* Quick add tools */}
      <span class="arena-section-label">Quick add</span>
      <div class="arena-tool-presets">
        <For each={TOOL_PRESETS}>
          {(tool) => (
            <button
              class="arena-tool-preset-btn"
              onClick={() => handleToolPreset(tool)}
              title={tool.command}
            >
              + {tool.name}
            </button>
          )}
        </For>
      </div>

      {/* Competitors */}
      <span class="arena-section-label">Competitors</span>
      <div class="arena-competitors-grid">
        <For each={arenaStore.competitors}>
          {(competitor, index) => (
            <div class="arena-competitor-card" data-arena={index()}>
              <div class="arena-competitor-card-header">
                <span class="arena-competitor-card-number">Competitor {index() + 1}</span>
                <button
                  class="arena-remove-btn"
                  disabled={arenaStore.competitors.length <= MIN_COMPETITORS}
                  onClick={() => removeCompetitor(competitor.id)}
                  title="Remove competitor"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
                  </svg>
                </button>
              </div>
              <input
                class="arena-competitor-input"
                type="text"
                placeholder="Name (e.g. Claude, Codex, Gemini)"
                value={competitor.name}
                onInput={(e) => updateCompetitor(competitor.id, { name: e.currentTarget.value })}
              />
              <input
                class="arena-competitor-input arena-command-input"
                type="text"
                placeholder={'Command — use {prompt} for the arena prompt'}
                value={competitor.command}
                onInput={(e) => updateCompetitor(competitor.id, { command: e.currentTarget.value })}
              />
            </div>
          )}
        </For>
      </div>

      <Show when={arenaStore.competitors.length < MAX_COMPETITORS}>
        <button class="arena-add-btn" onClick={() => addCompetitor()}>
          + Add Competitor
        </button>
      </Show>

      {/* Project */}
      <span class="arena-section-label">Project</span>
      <ProjectSelect
        value={store.projects.find((p) => p.path === arenaStore.cwd)?.id ?? null}
        onChange={(id) => setCwd(id ? (getProject(id)?.path ?? '') : '')}
        placeholder="Select a project..."
      />

      {/* Prompt */}
      <span class="arena-section-label">Prompt</span>
      <textarea
        class="arena-prompt-area"
        placeholder="Enter the coding task prompt that all competitors will receive..."
        value={arenaStore.prompt}
        onInput={(e) => setPrompt(e.currentTarget.value)}
      />

      <Show when={fightError()}>
        <div class="arena-merge-error">{fightError()}</div>
      </Show>

      {/* Actions */}
      <div class="arena-config-actions">
        <button class="arena-fight-btn" disabled={!canFight() || preparing()} onClick={handleFight}>
          <svg
            width="20"
            height="20"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            style={{ 'margin-right': '6px' }}
          >
            <path d="M3 3L13 13M9 12L12 9" />
            <path d="M13 3L3 13M4 9L7 12" />
          </svg>
          Fight!
        </button>
      </div>

      {/* Presets */}
      <span class="arena-section-label">Saved presets</span>
      <Show when={arenaStore.presets.length > 0}>
        <For each={arenaStore.presets}>
          {(preset) => (
            <div class="arena-preset-row">
              <button class="arena-preset-btn" onClick={() => handleApplyPreset(preset)}>
                {preset.name}
              </button>
              <button
                class="arena-preset-delete-btn"
                onClick={() => handleDeletePreset(preset.id)}
                title="Delete preset"
              >
                x
              </button>
            </div>
          )}
        </For>
      </Show>

      <Show when={!showPresetSave()}>
        <button class="arena-preset-btn" onClick={() => setShowPresetSave(true)}>
          Save current as preset
        </button>
      </Show>

      <Show when={showPresetSave()}>
        <div class="arena-preset-row">
          <input
            class="arena-competitor-input"
            type="text"
            placeholder="Preset name"
            value={presetName()}
            onInput={(e) => setPresetName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSavePreset();
              if (e.key === 'Escape') setShowPresetSave(false);
            }}
          />
          <button class="arena-preset-btn" onClick={handleSavePreset}>
            Save
          </button>
          <button class="arena-preset-btn" onClick={() => setShowPresetSave(false)}>
            Cancel
          </button>
        </div>
      </Show>

      {/* History link */}
      <button class="arena-history-link" onClick={() => setPhase('history')}>
        View match history
      </button>
    </div>
  );
}
