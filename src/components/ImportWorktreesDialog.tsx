import { For, Show, createEffect, createMemo, createSignal, createUniqueId } from 'solid-js';
import { Dialog } from './Dialog';
import { DialogFooter } from './DialogFooter';
import { AgentSelector } from './AgentSelector';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { createImportedTask, getProjectPath, loadAgents, store } from '../store/store';
import { dialogButtonStyle, theme } from '../lib/theme';
import type { Project } from '../store/types';
import type { AgentDef, ImportableWorktree } from '../ipc/types';
import { DownloadIcon } from './icons';

interface ImportWorktreesDialogProps {
  open: boolean;
  project: Project | null;
  initialCandidates?: ImportableWorktree[] | null;
  onClose: () => void;
}

export function shouldDisableImportClose(importing: boolean): boolean {
  return importing;
}

export function ImportWorktreesDialog(props: ImportWorktreesDialogProps) {
  const [candidates, setCandidates] = createSignal<ImportableWorktree[]>([]);
  const [selectedPaths, setSelectedPaths] = createSignal<Set<string>>(new Set());
  const [selectedAgent, setSelectedAgent] = createSignal<AgentDef | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [importing, setImporting] = createSignal(false);
  const [error, setError] = createSignal('');
  const titleId = createUniqueId();

  const trackedWorktreePaths = createMemo(() => {
    const projectId = props.project?.id;
    if (!projectId) return new Set<string>();

    const paths = new Set<string>();
    for (const taskId of [...store.taskOrder, ...store.collapsedTaskOrder]) {
      const task = store.tasks[taskId];
      if (!task || task.projectId !== projectId) continue;
      paths.add(task.worktreePath);
    }
    return paths;
  });

  const visibleCandidates = createMemo(() =>
    candidates().filter((candidate) => !trackedWorktreePaths().has(candidate.path)),
  );

  createEffect(() => {
    if (!props.open || !props.project) return;

    setLoading(true);
    setImporting(false);
    setError('');
    setCandidates([]);
    setSelectedPaths(new Set<string>());

    void (async () => {
      const project = props.project;
      if (!project) {
        setLoading(false);
        return;
      }
      if (store.availableAgents.length === 0) {
        await loadAgents();
      }
      const defaultAgent = store.lastAgentId
        ? (store.availableAgents.find((agent) => agent.id === store.lastAgentId) ?? null)
        : null;
      setSelectedAgent(defaultAgent ?? store.availableAgents[0] ?? null);

      const projectPath = getProjectPath(project.id);
      if (!projectPath) {
        setError('Project path not found');
        setLoading(false);
        return;
      }

      try {
        const nextCandidates =
          props.initialCandidates ??
          (await invoke<ImportableWorktree[]>(IPC.ListImportableWorktrees, {
            projectRoot: projectPath,
          }));
        setCandidates(nextCandidates);
        setSelectedPaths(new Set(nextCandidates.map((candidate) => candidate.path)));
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    })();
  });

  function togglePath(path: string): void {
    const next = new Set(selectedPaths());
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setSelectedPaths(next);
  }

  const selectedCount = () =>
    visibleCandidates().filter((candidate) => selectedPaths().has(candidate.path)).length;

  const canImport = () =>
    !loading() &&
    !importing() &&
    !!props.project &&
    !!selectedAgent() &&
    visibleCandidates().some((candidate) => selectedPaths().has(candidate.path));

  // Says why Import is unavailable; loading and importing explain themselves.
  const importBlockedReason = () => {
    if (loading() || importing() || !props.project) return undefined;
    if (!selectedAgent()) return 'Choose an agent first';
    if (!visibleCandidates().some((candidate) => selectedPaths().has(candidate.path)))
      return 'Select at least one worktree';
    return undefined;
  };

  const closeDisabled = () => shouldDisableImportClose(importing());

  function handleClose(): void {
    if (closeDisabled()) return;
    props.onClose();
  }

  async function handleImport(): Promise<void> {
    const project = props.project;
    const agent = selectedAgent();
    if (!project || !agent) return;

    const selected = visibleCandidates().filter((candidate) => selectedPaths().has(candidate.path));
    if (selected.length === 0) return;

    setImporting(true);
    setError('');
    try {
      for (const candidate of selected) {
        await createImportedTask({
          projectId: project.id,
          worktree: candidate,
          agentDef: agent,
        });
      }
      props.onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog
      open={props.open}
      onClose={handleClose}
      width="560px"
      panelStyle={{ gap: '18px' }}
      labelledBy={titleId}
    >
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '18px' }}>
        <div>
          <h2
            id={titleId}
            style={{
              margin: '0 0 6px',
              'font-size': '16px',
              color: theme.fg,
              'font-weight': '600',
            }}
          >
            Import Existing Worktrees
          </h2>
          <p
            style={{ margin: '0', 'font-size': '12px', color: theme.fgMuted, 'line-height': '1.5' }}
          >
            Import existing git worktrees for this project as Parallel Code tasks. Imported tasks
            keep their existing branch and worktree, and closing them will only detach them from the
            app.
          </p>
        </div>

        <AgentSelector
          agents={store.availableAgents}
          selectedAgent={selectedAgent()}
          onSelect={setSelectedAgent}
        />

        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
          <label
            style={{
              'font-size': '11px',
              color: theme.fgMuted,
              'text-transform': 'uppercase',
              'letter-spacing': '0.05em',
            }}
          >
            Worktrees
          </label>

          <Show when={!loading() && visibleCandidates().length > 0}>
            <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
              <span style={{ flex: '1', color: theme.fgMuted, 'font-size': '12px' }}>
                {selectedCount()} of {visibleCandidates().length} selected
              </span>
              <button
                type="button"
                class="btn-secondary"
                disabled={importing()}
                style={dialogButtonStyle(false, importing())}
                onClick={() =>
                  setSelectedPaths(new Set(visibleCandidates().map((candidate) => candidate.path)))
                }
              >
                Select all
              </button>
              <button
                type="button"
                class="btn-secondary"
                disabled={importing()}
                style={dialogButtonStyle(false, importing())}
                onClick={() => setSelectedPaths(new Set())}
              >
                Clear
              </button>
            </div>
          </Show>
          <Show when={loading()}>
            <div
              style={{
                padding: '12px 14px',
                'font-size': '12px',
                color: theme.fgMuted,
                background: theme.bgInput,
                border: `1px solid ${theme.border}`,
                'border-radius': 'var(--radius-md)',
              }}
            >
              Scanning for existing worktrees...
            </div>
          </Show>

          <Show when={!loading() && visibleCandidates().length === 0}>
            <div
              style={{
                padding: '12px 14px',
                'font-size': '12px',
                color: theme.fgMuted,
                background: theme.bgInput,
                border: `1px solid ${theme.border}`,
                'border-radius': 'var(--radius-md)',
              }}
            >
              No importable worktrees were found for this project.
            </div>
          </Show>

          <Show when={!loading() && visibleCandidates().length > 0}>
            <div
              style={{
                display: 'flex',
                'flex-direction': 'column',
                gap: '8px',
                'max-height': '280px',
                overflow: 'auto',
              }}
            >
              <For each={visibleCandidates()}>
                {(candidate) => {
                  const selected = () => selectedPaths().has(candidate.path);
                  return (
                    <label
                      style={{
                        display: 'flex',
                        gap: '10px',
                        padding: '12px 14px',
                        background: selected() ? theme.bgSelected : theme.bgInput,
                        border: selected()
                          ? `1px solid ${theme.accent}`
                          : `1px solid ${theme.border}`,
                        'border-radius': 'var(--radius-md)',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        disabled={importing()}
                        checked={selected()}
                        onChange={() => togglePath(candidate.path)}
                        style={{ 'margin-top': '2px', cursor: 'pointer' }}
                      />
                      <div
                        style={{
                          flex: '1',
                          'min-width': '0',
                          display: 'flex',
                          'flex-direction': 'column',
                          gap: '6px',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            'align-items': 'center',
                            gap: '8px',
                            'flex-wrap': 'wrap',
                          }}
                        >
                          <span
                            style={{
                              'font-size': '13px',
                              color: theme.fg,
                              'font-weight': '600',
                              'font-family': "'JetBrains Mono', monospace",
                            }}
                          >
                            {candidate.branch_name}
                          </span>
                          <StatusBadge
                            label={
                              candidate.has_uncommitted_changes ? 'Uncommitted changes' : 'Clean'
                            }
                            tone={candidate.has_uncommitted_changes ? 'warning' : 'muted'}
                          />
                          <Show when={candidate.has_committed_changes}>
                            <StatusBadge label="Has commits" tone="accent" />
                          </Show>
                        </div>
                        <div
                          style={{
                            'font-size': '11px',
                            color: theme.fgSubtle,
                            'font-family': "'JetBrains Mono', monospace",
                            'word-break': 'break-all',
                          }}
                        >
                          {candidate.path}
                        </div>
                      </div>
                    </label>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>

        <DialogFooter error={error()} note={importBlockedReason()}>
          <button
            type="button"
            class="btn-secondary"
            disabled={closeDisabled()}
            onClick={handleClose}
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn-primary"
            style={{ 'min-width': '180px' }}
            disabled={!canImport()}
            title={importBlockedReason()}
            onClick={() => void handleImport()}
          >
            <DownloadIcon size={14} />
            {importing()
              ? 'Importing...'
              : `Import ${selectedCount()} worktree${selectedCount() === 1 ? '' : 's'}`}
          </button>
        </DialogFooter>
      </div>
    </Dialog>
  );
}

function StatusBadge(props: { label: string; tone: 'accent' | 'warning' | 'muted' }) {
  const color = () =>
    props.tone === 'accent'
      ? theme.accent
      : props.tone === 'warning'
        ? theme.warning
        : theme.fgMuted;
  return (
    <span
      style={{
        'font-size': '11px',
        'font-weight': '600',
        padding: '2px 7px',
        'border-radius': '999px',
        color: color(),
        background: `color-mix(in srgb, ${color()} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color()} 20%, transparent)`,
      }}
    >
      {props.label}
    </span>
  );
}
