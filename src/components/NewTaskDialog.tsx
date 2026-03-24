import { createSignal, createEffect, Show, For, onCleanup } from 'solid-js';
import { Dialog } from './Dialog';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import {
  store,
  createTask,
  toggleNewTaskDialog,
  loadAgents,
  getProject,
  getProjectPath,
  getProjectBranchPrefix,
  updateProject,
  hasDirectTask,
  getGitHubDropDefaults,
  setPrefillPrompt,
  setDockerAvailable,
  setDockerImage,
} from '../store/store';
import type { GitIsolationMode } from '../store/types';
import { toBranchName, sanitizeBranchPrefix } from '../lib/branch-name';
import { SegmentedButtons } from './SegmentedButtons';
import { cleanTaskName } from '../lib/clean-task-name';
import { extractGitHubUrl } from '../lib/github-url';
import { theme, sectionLabelStyle, bannerStyle } from '../lib/theme';
import { AgentSelector } from './AgentSelector';
import { BranchPrefixField } from './BranchPrefixField';
import { ProjectSelect } from './ProjectSelect';
import { SymlinkDirPicker } from './SymlinkDirPicker';
import type { AgentDef } from '../ipc/types';

interface NewTaskDialogProps {
  open: boolean;
  onClose: () => void;
}

export function NewTaskDialog(props: NewTaskDialogProps) {
  const [prompt, setPrompt] = createSignal('');
  const [name, setName] = createSignal('');
  const [selectedAgent, setSelectedAgent] = createSignal<AgentDef | null>(null);
  const [selectedProjectId, setSelectedProjectId] = createSignal<string | null>(null);
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [ignoredDirs, setIgnoredDirs] = createSignal<string[]>([]);
  const [selectedDirs, setSelectedDirs] = createSignal<Set<string>>(new Set());
  const [gitIsolation, setGitIsolation] = createSignal<GitIsolationMode>('worktree');
  const [baseBranch, setBaseBranch] = createSignal('');
  const [branches, setBranches] = createSignal<string[]>([]);
  const [skipPermissions, setSkipPermissions] = createSignal(false);
  const [coordinatorMode, setCoordinatorMode] = createSignal(false);
  const [dockerMode, setDockerMode] = createSignal(false);
  const [dockerImageReady, setDockerImageReady] = createSignal<boolean | null>(null); // null = unknown
  const [dockerBuilding, setDockerBuilding] = createSignal(false);
  const [dockerBuildOutput, setDockerBuildOutput] = createSignal('');
  const [dockerBuildError, setDockerBuildError] = createSignal('');

  const [branchPrefix, setBranchPrefix] = createSignal('');
  let promptRef!: HTMLTextAreaElement;
  let formRef!: HTMLFormElement;
  let buildOutputRef!: HTMLPreElement;

  const focusableSelector =
    'textarea:not(:disabled), input:not(:disabled), select:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex="-1"])';

  function navigateDialogFields(direction: 'up' | 'down'): void {
    if (!formRef) return;
    const sections = Array.from(formRef.querySelectorAll<HTMLElement>('[data-nav-field]'));
    if (sections.length === 0) return;

    const active = document.activeElement as HTMLElement | null;
    const currentIdx = active ? sections.findIndex((s) => s.contains(active)) : -1;

    let nextIdx: number;
    if (currentIdx === -1) {
      nextIdx = direction === 'down' ? 0 : sections.length - 1;
    } else if (direction === 'down') {
      nextIdx = (currentIdx + 1) % sections.length;
    } else {
      nextIdx = (currentIdx - 1 + sections.length) % sections.length;
    }

    const target = sections[nextIdx];
    const focusable = target.querySelector<HTMLElement>(focusableSelector);
    focusable?.focus();
  }

  function navigateWithinField(direction: 'left' | 'right'): void {
    if (!formRef) return;
    const active = document.activeElement as HTMLElement | null;
    if (!active) return;

    const section = active.closest<HTMLElement>('[data-nav-field]');
    if (!section) return;

    const focusables = Array.from(section.querySelectorAll<HTMLElement>(focusableSelector));
    if (focusables.length <= 1) return;

    const idx = focusables.indexOf(active);
    if (idx === -1) return;

    let nextIdx: number;
    if (direction === 'right') {
      nextIdx = (idx + 1) % focusables.length;
    } else {
      nextIdx = (idx - 1 + focusables.length) % focusables.length;
    }
    focusables[nextIdx].focus();
  }

  // Initialize state each time the dialog opens
  createEffect(() => {
    if (!props.open) return;

    // Reset signals for a fresh dialog
    setPrompt('');
    setName('');
    setError('');
    setLoading(false);
    setGitIsolation('worktree');
    setBaseBranch('');
    setBranches([]);
    setSkipPermissions(false);
    setCoordinatorMode(false);
    setDockerMode(false);
    setDockerImageReady(null);
    setDockerBuilding(false);
    setDockerBuildOutput('');
    setDockerBuildError('');

    void (async () => {
      // Check Docker availability in background
      invoke<boolean>(IPC.CheckDockerAvailable).then(
        (available) => setDockerAvailable(available),
        () => setDockerAvailable(false),
      );
      if (store.availableAgents.length === 0) {
        await loadAgents();
      }
      const lastAgent = store.lastAgentId
        ? (store.availableAgents.find((a) => a.id === store.lastAgentId) ?? null)
        : null;
      setSelectedAgent(lastAgent ?? store.availableAgents[0] ?? null);

      // Pre-fill from drop data if present
      const dropUrl = store.newTaskDropUrl;
      const fallbackProjectId = store.lastProjectId ?? store.projects[0]?.id ?? null;
      const defaults = dropUrl ? getGitHubDropDefaults(dropUrl) : null;

      if (dropUrl) setPrompt(`review ${dropUrl}`);
      if (defaults) setName(defaults.name);
      setSelectedProjectId(defaults?.projectId ?? fallbackProjectId);

      // Pre-fill from arena comparison prompt
      const prefill = store.newTaskPrefillPrompt;
      if (prefill) {
        setPrompt(prefill.prompt);
        setName('Compare arena results');
        if (prefill.projectId) setSelectedProjectId(prefill.projectId);
      }

      promptRef?.focus();
    })();

    // Capture-phase handler for Alt+Arrow to navigate form sections / within fields
    const handleAltArrow = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopImmediatePropagation();
        navigateDialogFields(e.key === 'ArrowDown' ? 'down' : 'up');
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // Preserve native word-jump (Alt+Arrow) in text inputs
        const tag = (document.activeElement as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        e.stopImmediatePropagation();
        navigateWithinField(e.key === 'ArrowRight' ? 'right' : 'left');
      }
    };
    window.addEventListener('keydown', handleAltArrow, true);

    onCleanup(() => {
      window.removeEventListener('keydown', handleAltArrow, true);
    });
  });

  // Fetch gitignored dirs when project changes
  createEffect(() => {
    const pid = selectedProjectId();
    const path = pid ? getProjectPath(pid) : undefined;
    let cancelled = false;

    if (!path) {
      setIgnoredDirs([]);
      setSelectedDirs(new Set<string>());
      return;
    }

    void (async () => {
      try {
        const dirs = await invoke<string[]>(IPC.GetGitignoredDirs, { projectRoot: path });
        if (cancelled) return;
        setIgnoredDirs(dirs);
        setSelectedDirs(new Set(dirs)); // all checked by default
      } catch {
        if (cancelled) return;
        setIgnoredDirs([]);
        setSelectedDirs(new Set<string>());
      }
    })();

    onCleanup(() => {
      cancelled = true;
    });
  });

  // Sync branch prefix when project changes
  createEffect(() => {
    const pid = selectedProjectId();
    setBranchPrefix(pid ? getProjectBranchPrefix(pid) : 'task');
  });

  // Fetch branches and set default base branch when project changes
  createEffect(() => {
    const pid = selectedProjectId();
    const projectPath = pid ? getProjectPath(pid) : undefined;
    let cancelled = false;

    if (!projectPath) {
      setBranches([]);
      setBaseBranch('');
      return;
    }

    void (async () => {
      try {
        const [branchList, mainBranch] = await Promise.all([
          invoke<string[]>(IPC.GetBranches, { projectRoot: projectPath }),
          invoke<string>(IPC.GetMainBranch, { projectRoot: projectPath }),
        ]);
        if (cancelled) return;
        setBranches(branchList);
        const proj = pid ? getProject(pid) : undefined;
        setBaseBranch(proj?.defaultBaseBranch ?? mainBranch);
      } catch {
        if (cancelled) return;
        setBranches([]);
      }
    })();

    onCleanup(() => {
      cancelled = true;
    });
  });

  // Set isolation mode from project defaults, enforce worktree if a direct task already exists
  createEffect(() => {
    const pid = selectedProjectId();
    if (!pid) return;
    if (hasDirectTask(pid)) {
      setGitIsolation('worktree');
      return;
    }
    const proj = getProject(pid);
    setGitIsolation(proj?.defaultGitIsolation ?? 'worktree');
  });

  // Auto-enable Docker when skip-permissions is turned on and Docker is available
  createEffect(() => {
    if (skipPermissions() && store.dockerAvailable) {
      setDockerMode(true);
    }
  });

  // Check if the default Docker image exists when Docker mode is enabled (debounced)
  let checkTimer: ReturnType<typeof setTimeout>;
  createEffect(() => {
    if (dockerMode() && store.dockerAvailable) {
      const image = store.dockerImage || 'parallel-code-agent:latest';
      clearTimeout(checkTimer);
      checkTimer = setTimeout(() => {
        invoke<boolean>(IPC.CheckDockerImageExists, { image }).then(
          (exists) => setDockerImageReady(exists),
          () => setDockerImageReady(false),
        );
      }, 300);
    } else {
      setDockerImageReady(null);
    }
  });

  // Auto-scroll build output to bottom
  createEffect(() => {
    dockerBuildOutput(); // track
    if (buildOutputRef) {
      buildOutputRef.scrollTop = buildOutputRef.scrollHeight;
    }
  });

  async function handleBuildImage() {
    setDockerBuilding(true);
    setDockerBuildOutput('');
    setDockerBuildError('');

    const channelId = `docker-build-${Date.now()}`;

    // Listen for build output
    const cleanup = window.electron.ipcRenderer.on(`channel:${channelId}`, (...args: unknown[]) => {
      setDockerBuildOutput((prev) => prev + String(args[0] ?? ''));
    });

    try {
      const result = await invoke<{ ok: boolean; error?: string }>(IPC.BuildDockerImage, {
        onOutputChannel: `channel:${channelId}`,
      });
      if (result.ok) {
        setDockerImageReady(true);
        setDockerBuildOutput((prev) => prev + '\nImage built successfully!');
      } else {
        setDockerBuildError(result.error || 'Build failed');
      }
    } catch (err) {
      setDockerBuildError(String(err));
    } finally {
      setDockerBuilding(false);
      if (cleanup) cleanup();
    }
  }

  const effectiveName = () => {
    const n = name().trim();
    if (n) return n;
    const p = prompt().trim();
    if (!p) return '';
    // Use first line, clean filler phrases, truncate at ~40 chars on word boundary
    const firstLine = cleanTaskName(p.split('\n')[0]);
    if (firstLine.length <= 40) return firstLine;
    return firstLine.slice(0, 40).replace(/\s+\S*$/, '') || firstLine.slice(0, 40);
  };

  const branchPreview = () => {
    const n = effectiveName();
    const prefix = sanitizeBranchPrefix(branchPrefix());
    return n ? `${prefix}/${toBranchName(n)}` : '';
  };

  const selectedProjectPath = () => {
    const pid = selectedProjectId();
    return pid ? getProjectPath(pid) : undefined;
  };

  const directDisabled = () => {
    const pid = selectedProjectId();
    return pid ? hasDirectTask(pid) : false;
  };

  const agentSupportsSkipPermissions = () => {
    const agent = selectedAgent();
    return !!agent?.skip_permissions_args?.length;
  };

  const canSubmit = () => {
    const hasContent = !!effectiveName();
    return hasContent && !!selectedProjectId() && !loading();
  };

  async function handleSubmit(e: Event) {
    e.preventDefault();
    const n = effectiveName();
    if (!n) return;

    const agent = selectedAgent();
    if (!agent) {
      setError('Select an agent');
      return;
    }

    const projectId = selectedProjectId();
    if (!projectId) {
      setError('Select a project');
      return;
    }

    setLoading(true);
    setError('');

    const p = prompt().trim() || undefined;
    const isFromDrop = !!store.newTaskDropUrl;
    const prefix = sanitizeBranchPrefix(branchPrefix());
    const ghUrl = (p ? extractGitHubUrl(p) : null) ?? store.newTaskDropUrl ?? undefined;
    try {
      // Persist the branch prefix to the project for next time
      updateProject(projectId, { branchPrefix: prefix });

      if (gitIsolation() === 'direct') {
        const projectPath = getProjectPath(projectId);
        if (!projectPath) {
          setError('Project path not found');
          return;
        }
        const currentBranch = await invoke<string>(IPC.GetCurrentBranch, {
          projectRoot: projectPath,
        });
        if (currentBranch !== baseBranch()) {
          setError(
            `Repository is on branch "${currentBranch}", not "${baseBranch()}". Please checkout ${baseBranch()} first.`,
          );
          return;
        }
      }

      const taskId = await createTask({
        name: n,
        agentDef: agent,
        projectId,
        gitIsolation: gitIsolation(),
        baseBranch: baseBranch(),
        symlinkDirs: gitIsolation() === 'worktree' ? [...selectedDirs()] : undefined,
        branchPrefixOverride: gitIsolation() === 'worktree' ? prefix : undefined,
        initialPrompt: isFromDrop ? undefined : p,
        githubUrl: ghUrl,
        skipPermissions: agentSupportsSkipPermissions() && skipPermissions(),
        dockerMode: dockerMode() || undefined,
        dockerImage: dockerMode() ? store.dockerImage : undefined,
        coordinatorMode: coordinatorMode() || undefined,
      });
      // Drop flow: prefill prompt without auto-sending
      if (isFromDrop && p) {
        setPrefillPrompt(taskId, p);
      }
      toggleNewTaskDialog(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={props.open} onClose={props.onClose} width="420px" panelStyle={{ gap: '20px' }}>
      <form
        ref={formRef}
        onSubmit={handleSubmit}
        style={{
          display: 'flex',
          'flex-direction': 'column',
          gap: '20px',
        }}
      >
        <div>
          <h2
            style={{
              margin: '0 0 6px',
              'font-size': '16px',
              color: theme.fg,
              'font-weight': '600',
            }}
          >
            New Task
          </h2>
          <p
            style={{ margin: '0', 'font-size': '12px', color: theme.fgMuted, 'line-height': '1.5' }}
          >
            {gitIsolation() === 'direct'
              ? 'The AI agent will work directly on your main branch in the project root.'
              : 'Creates a git branch and worktree so the AI agent can work in isolation without affecting your main branch.'}
          </p>
        </div>

        {/* Project selector */}
        <div
          data-nav-field="project"
          style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
        >
          <label style={sectionLabelStyle}>Project</label>
          <ProjectSelect value={selectedProjectId()} onChange={setSelectedProjectId} />
        </div>

        {/* Prompt input (optional) */}
        <div
          data-nav-field="prompt"
          style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
        >
          <label style={sectionLabelStyle}>
            Prompt <span style={{ opacity: '0.5', 'text-transform': 'none' }}>(optional)</span>
          </label>
          <textarea
            ref={promptRef}
            class="input-field"
            value={prompt()}
            onInput={(e) => setPrompt(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                e.stopPropagation();
                if (canSubmit()) handleSubmit(e);
              }
            }}
            placeholder="What should the agent work on?"
            rows={3}
            style={{
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              padding: '10px 14px',
              color: theme.fg,
              'font-size': '13px',
              'font-family': "'JetBrains Mono', monospace",
              outline: 'none',
              resize: 'vertical',
            }}
          />
        </div>

        <div
          data-nav-field="task-name"
          style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
        >
          <label style={sectionLabelStyle}>
            Task name{' '}
            <span style={{ opacity: '0.5', 'text-transform': 'none' }}>
              (optional — derived from prompt)
            </span>
          </label>
          <input
            class="input-field"
            type="text"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            placeholder={effectiveName() || 'Add user authentication'}
            style={{
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              padding: '10px 14px',
              color: theme.fg,
              'font-size': '13px',
              outline: 'none',
            }}
          />
          <Show when={gitIsolation() === 'direct' && selectedProjectPath()}>
            <div
              style={{
                'font-size': '11px',
                'font-family': "'JetBrains Mono', monospace",
                color: theme.fgSubtle,
                display: 'flex',
                'flex-direction': 'column',
                gap: '2px',
                padding: '4px 2px 0',
              }}
            >
              <span style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  style={{ 'flex-shrink': '0' }}
                >
                  <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm6.25 7.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 7.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 0h5.5a2.5 2.5 0 0 0 2.5-2.5v-.5a.75.75 0 0 0-1.5 0v.5a1 1 0 0 1-1 1H5a3.25 3.25 0 1 0 0 6.5h6.25a.75.75 0 0 0 0-1.5H5a1.75 1.75 0 1 1 0-3.5Z" />
                </svg>
                main branch (detected on create)
              </span>
              <span style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  style={{ 'flex-shrink': '0' }}
                >
                  <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
                </svg>
                {selectedProjectPath()}
              </span>
            </div>
          </Show>
        </div>

        <Show when={gitIsolation() === 'worktree'}>
          <BranchPrefixField
            branchPrefix={branchPrefix()}
            branchPreview={branchPreview()}
            projectPath={selectedProjectPath()}
            onPrefixChange={setBranchPrefix}
          />
        </Show>

        <AgentSelector
          agents={store.availableAgents}
          selectedAgent={selectedAgent()}
          onSelect={setSelectedAgent}
        />

        {/* Coordinator mode toggle */}
        <div
          data-nav-field="coordinator-mode"
          style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
        >
          <label
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '8px',
              'font-size': '12px',
              color: gitIsolation() === 'direct' ? theme.fgSubtle : theme.fg,
              cursor: gitIsolation() === 'direct' ? 'not-allowed' : 'pointer',
              opacity: gitIsolation() === 'direct' ? '0.5' : '1',
            }}
          >
            <input
              type="checkbox"
              checked={coordinatorMode()}
              disabled={gitIsolation() === 'direct'}
              onChange={(e) => setCoordinatorMode(e.currentTarget.checked)}
              style={{ 'accent-color': theme.accent, cursor: 'inherit' }}
            />
            Coordinator mode
          </label>
          <Show when={coordinatorMode()}>
            <div
              style={{
                'font-size': '12px',
                color: theme.warning,
                background: `color-mix(in srgb, ${theme.warning} 8%, transparent)`,
                padding: '8px 12px',
                'border-radius': '8px',
                border: `1px solid color-mix(in srgb, ${theme.warning} 20%, transparent)`,
              }}
            >
              This agent will be able to create tasks, send prompts, and merge branches
              automatically via MCP tools. The remote server will be started automatically.
            </div>
          </Show>
        </div>

        {/* Isolation mode selector */}
        <div
          data-nav-field="git-isolation"
          style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
        >
          <label style={sectionLabelStyle}>Git Isolation</label>
          <SegmentedButtons
            options={[
              { value: 'worktree', label: 'Worktree' },
              { value: 'direct', label: 'Direct', disabled: directDisabled() },
            ]}
            value={gitIsolation()}
            onChange={setGitIsolation}
          />
          <Show when={directDisabled()}>
            <span style={{ 'font-size': '11px', color: theme.fgSubtle }}>
              A direct-mode task already exists for this project
            </span>
          </Show>
          <Show when={gitIsolation() === 'direct'}>
            <div style={{ ...bannerStyle(theme.warning), 'font-size': '12px' }}>
              Changes will be made directly on the selected branch without worktree isolation.
            </div>
          </Show>
        </div>

        {/* Branch picker */}
        <div
          data-nav-field="base-branch"
          style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
        >
          <label style={sectionLabelStyle}>
            {gitIsolation() === 'worktree' ? 'Base branch' : 'Branch'}
          </label>
          <select
            class="input-field"
            value={baseBranch()}
            onChange={(e) => setBaseBranch(e.currentTarget.value)}
            style={{
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              padding: '10px 14px',
              color: theme.fg,
              'font-size': '13px',
              'font-family': "'JetBrains Mono', monospace",
              outline: 'none',
            }}
          >
            <For each={branches()}>{(b) => <option value={b}>{b}</option>}</For>
          </select>
        </div>

        {/* Skip permissions toggle */}
        <Show when={agentSupportsSkipPermissions()}>
          <div
            data-nav-field="skip-permissions"
            style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
          >
            <label
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '8px',
                'font-size': '12px',
                color: theme.fg,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={skipPermissions()}
                onChange={(e) => setSkipPermissions(e.currentTarget.checked)}
                style={{ 'accent-color': theme.accent, cursor: 'inherit' }}
              />
              Dangerously skip all confirms
            </label>
            <Show when={skipPermissions()}>
              <div
                style={{
                  ...bannerStyle(theme.warning),
                  'font-size': '12px',
                }}
              >
                The agent will run without asking for confirmation. It can read, write, and delete
                files, and execute commands without your approval.
              </div>
              <Show when={!dockerMode() && store.dockerAvailable}>
                <div style={{ 'font-size': '11px', color: theme.fgMuted }}>
                  Tip: Enable Docker isolation to limit the blast radius of skip-permissions mode.
                </div>
              </Show>
              <Show when={!store.dockerAvailable}>
                <div style={{ 'font-size': '11px', color: theme.fgMuted }}>
                  Install Docker to enable container isolation for safer skip-permissions mode.
                </div>
              </Show>
            </Show>
          </div>
        </Show>

        {/* Docker isolation toggle */}
        <Show when={store.dockerAvailable}>
          <div
            data-nav-field="docker-mode"
            style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
          >
            <label
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '8px',
                'font-size': '12px',
                color: theme.fg,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={dockerMode()}
                onChange={(e) => setDockerMode(e.currentTarget.checked)}
                style={{ 'accent-color': theme.accent, cursor: 'inherit' }}
              />
              Run in Docker container
            </label>
            <Show when={dockerMode()}>
              <div
                style={{
                  'font-size': '12px',
                  color: theme.success ?? theme.accent,
                  background: `color-mix(in srgb, ${theme.success ?? theme.accent} 8%, transparent)`,
                  padding: '8px 12px',
                  'border-radius': '8px',
                  border: `1px solid color-mix(in srgb, ${theme.success ?? theme.accent} 20%, transparent)`,
                }}
              >
                The agent will run inside a Docker container. Only the project directory is mounted
                — files outside the project are protected from accidental deletion.
              </div>
              <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                <label
                  style={{ 'font-size': '11px', color: theme.fgMuted, 'white-space': 'nowrap' }}
                >
                  Image:
                </label>
                <input
                  type="text"
                  value={store.dockerImage}
                  onInput={(e) => setDockerImage(e.currentTarget.value)}
                  placeholder="parallel-code-agent:latest"
                  style={{
                    flex: '1',
                    background: theme.bgInput,
                    border: `1px solid ${theme.border}`,
                    'border-radius': '6px',
                    padding: '5px 10px',
                    color: theme.fg,
                    'font-size': '12px',
                    'font-family': "'JetBrains Mono', monospace",
                    outline: 'none',
                  }}
                />
              </div>
              <Show when={dockerImageReady() === false && !dockerBuilding()}>
                <div
                  style={{
                    display: 'flex',
                    'align-items': 'center',
                    gap: '8px',
                    'font-size': '11px',
                    color: theme.fgMuted,
                  }}
                >
                  <span>Image not found locally.</span>
                  <Show
                    when={store.dockerImage === 'parallel-code-agent:latest' || !store.dockerImage}
                  >
                    <button
                      type="button"
                      onClick={handleBuildImage}
                      style={{
                        background: theme.accent,
                        color: theme.accentText,
                        border: 'none',
                        'border-radius': '4px',
                        padding: '3px 10px',
                        'font-size': '11px',
                        cursor: 'pointer',
                      }}
                    >
                      Build Image
                    </button>
                  </Show>
                </div>
              </Show>
              <Show when={dockerBuilding()}>
                <div
                  style={{
                    'font-size': '11px',
                    color: theme.fgMuted,
                    display: 'flex',
                    'align-items': 'center',
                    gap: '6px',
                  }}
                >
                  <span class="inline-spinner" aria-hidden="true" />
                  Building image... this may take a few minutes.
                </div>
                <Show when={dockerBuildOutput()}>
                  <pre
                    ref={buildOutputRef}
                    style={{
                      'font-size': '10px',
                      color: theme.fgSubtle,
                      background: theme.bgInput,
                      'border-radius': '4px',
                      padding: '6px 8px',
                      'max-height': '120px',
                      'overflow-y': 'auto',
                      'white-space': 'pre-wrap',
                      'word-break': 'break-all',
                      margin: '0',
                    }}
                  >
                    {dockerBuildOutput()}
                  </pre>
                </Show>
              </Show>
              <Show when={dockerBuildError()}>
                <div style={{ 'font-size': '11px', color: theme.error }}>
                  Build failed: {dockerBuildError()}
                </div>
              </Show>
              <Show when={dockerImageReady() === true && !dockerBuilding()}>
                <div style={{ 'font-size': '11px', color: theme.success ?? theme.accent }}>
                  Image ready.
                </div>
              </Show>
            </Show>
          </div>
        </Show>

        <Show when={ignoredDirs().length > 0 && gitIsolation() === 'worktree'}>
          <SymlinkDirPicker
            dirs={ignoredDirs()}
            selectedDirs={selectedDirs()}
            onToggle={(dir) => {
              const next = new Set(selectedDirs());
              if (next.has(dir)) next.delete(dir);
              else next.add(dir);
              setSelectedDirs(next);
            }}
          />
        </Show>

        <Show when={error()}>
          <div
            style={{
              ...bannerStyle(theme.error),
              'font-size': '12px',
            }}
          >
            {error()}
          </div>
        </Show>

        <div
          data-nav-field="footer"
          style={{
            display: 'flex',
            gap: '8px',
            'justify-content': 'flex-end',
            'padding-top': '4px',
          }}
        >
          <button
            type="button"
            class="btn-secondary"
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
            type="submit"
            class="btn-primary"
            disabled={!canSubmit()}
            style={{
              padding: '9px 20px',
              background: theme.accent,
              border: 'none',
              'border-radius': '8px',
              color: theme.accentText,
              cursor: 'pointer',
              'font-size': '13px',
              'font-weight': '500',
              opacity: !canSubmit() ? '0.4' : '1',
              display: 'inline-flex',
              'align-items': 'center',
              gap: '8px',
            }}
          >
            <Show when={loading()}>
              <span class="inline-spinner" aria-hidden="true" />
            </Show>
            {loading() ? 'Creating...' : 'Create Task'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
