import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import { Dialog } from './Dialog';
import { AgentSelector } from './AgentSelector';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { createImportedTask, getProjectPath, loadAgents, store } from '../store/store';
import { theme } from '../lib/theme';
import type { Project } from '../store/types';
import type { AgentDef, ImportableWorktree } from '../ipc/types';

interface ImportWorktreesDialogProps {
  open: boolean;
  project: Project | null;
  initialCandidates?: ImportableWorktree[] | null;
  onClose: () => void;
}

export function ImportWorktreesDialog(props: ImportWorktreesDialogProps) {
  const [candidates, setCandidates] = createSignal<ImportableWorktree[]>([]);
  const [selectedPaths, setSelectedPaths] = createSignal<Set<string>>(new Set());
  const [selectedAgent, setSelectedAgent] = createSignal<AgentDef | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [importing, setImporting] = createSignal(false);
  const [error, setError] = createSignal('');

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

  const canImport = () =>
    !loading() &&
    !importing() &&
    !!props.project &&
    !!selectedAgent() &&
    visibleCandidates().some((candidate) => selectedPaths().has(candidate.path));

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
    <Dialog open={props.open} onClose={props.onClose} width="560px" panelStyle={{ gap: '18px' }}>
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '18px' }}>
        <div>
          <h2
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

          <Show when={loading()}>
            <div
              style={{
                padding: '12px 14px',
                'font-size': '12px',
                color: theme.fgMuted,
                background: theme.bgInput,
                border: `1px solid ${theme.border}`,
                'border-radius': '8px',
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
                'border-radius': '8px',
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
                        'border-radius': '10px',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
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
                            label={candidate.has_uncommitted_changes ? 'Dirty' : 'Clean'}
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

        <Show when={error()}>
          <div
            style={{
              'font-size': '12px',
              color: theme.error,
              background: `color-mix(in srgb, ${theme.error} 8%, transparent)`,
              padding: '8px 12px',
              'border-radius': '8px',
              border: `1px solid color-mix(in srgb, ${theme.error} 20%, transparent)`,
            }}
          >
            {error()}
          </div>
        </Show>

        <div style={{ display: 'flex', 'justify-content': 'flex-end', gap: '8px' }}>
          <button
            type="button"
            onClick={() => props.onClose()}
            style={{
              padding: '9px 18px',
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              color: theme.fgMuted,
              cursor: 'pointer',
              'font-size': '13px',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canImport()}
            onClick={() => void handleImport()}
            style={{
              padding: '9px 18px',
              background: theme.accent,
              border: 'none',
              'border-radius': '8px',
              color: theme.accentText,
              cursor: canImport() ? 'pointer' : 'not-allowed',
              'font-size': '13px',
              'font-weight': '600',
              opacity: canImport() ? '1' : '0.4',
            }}
          >
            {importing() ? 'Importing...' : 'Import Selected'}
          </button>
        </div>
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
        'font-size': '10px',
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
