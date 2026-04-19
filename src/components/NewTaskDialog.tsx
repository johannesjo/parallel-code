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
  showNotification,
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
import { DEFAULT_DOCKER_IMAGE, PROJECT_DOCKERFILE_RELATIVE_PATH } from '../lib/docker';

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
  const [branchesLoading, setBranchesLoading] = createSignal(false);
  const [stepsEnabled, setStepsEnabled] = createSignal(store.showSteps);
  const [skipPermissions, setSkipPermissions] = createSignal(false);
  const [dockerMode, setDockerMode] = createSignal(false);
  const [dockerImageReady, setDockerImageReady] = createSignal<boolean | null>(null); // null = unknown
  const [dockerBuilding, setDockerBuilding] = createSignal(false);
  const [dockerBuildOutput, setDockerBuildOutput] = createSignal('');
  const [dockerBuildError, setDockerBuildError] = createSignal('');
  const [projectDockerfile, setProjectDockerfile] = createSignal<{
    dockerfilePath: string;
    imageTag: string;
    buildContext: string;
  } | null>(null);
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
    setSkipPermissions(false);
    setDockerMode(false);
    setDockerImageReady(null);
    setDockerBuilding(false);
    setDockerBuildOutput('');
    setDockerBuildError('');
    setProjectDockerfile(null);

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

  // Fetch branches on every dialog open and on project change (D-02 merged effect)
  createEffect(() => {
    // D-02, D-03: All reactive reads synchronous before any async code
    const open = props.open;
    const pid = selectedProjectId();
    const projectPath = pid ? getProjectPath(pid) : undefined;
    let cancelled = false;

    if (!open || !projectPath) {
      setBranches([]);
      setBaseBranch('');
      setBranchesLoading(false);
      // D-03: onCleanup registered synchronously even on early return
      onCleanup(() => {
        cancelled = true;
      });
      return;
    }

    // D-01: Clear list and show spinner immediately on every open
    setBranches([]);
    setBranchesLoading(true);

    const doFetch = async () => {
      const [branchList, mainBranch] = await Promise.all([
        invoke<string[]>(IPC.GetBranches, { projectRoot: projectPath }),
        invoke<string>(IPC.GetMainBranch, { projectRoot: projectPath }),
      ]);
      if (cancelled) return;
      // Set both in same synchronous sequence — avoids SolidJS #2241 select value race
      setBranches(branchList);
      const proj = pid ? getProject(pid) : undefined;
      setBaseBranch(proj?.defaultBaseBranch ?? mainBranch);
      setBranchesLoading(false);
    };

    void doFetch().catch(async () => {
      // D-04: Retry once silently
      if (cancelled) return;
      try {
        await doFetch();
      } catch (err) {
        if (cancelled) return;
        setBranchesLoading(false);
        showNotification(`Failed to load branches: ${String(err)}`);
      }
    });

    // D-03: onCleanup MUST be synchronous in effect body, not inside the IIFE
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

  // Detect per-project Dockerfile when Docker mode is enabled
  createEffect(() => {
    if (!dockerMode() || !store.dockerAvailable) {
      setProjectDockerfile(null);
      return;
    }

    const pid = selectedProjectId();
    if (!pid) {
      setProjectDockerfile(null);
      return;
    }

    const projectRoot = getProjectPath(pid);
    if (!projectRoot) {
      setProjectDockerfile(null);
      return;
    }

    let cancelled = false;
    invoke<{ dockerfilePath: string; imageTag: string; buildContext: string } | null>(
      IPC.ResolveProjectDockerfile,
      { projectRoot },
    ).then(
      (result) => {
        if (!cancelled) setProjectDockerfile(result);
      },
      () => {
        if (!cancelled) setProjectDockerfile(null);
      },
    );

    onCleanup(() => {
      cancelled = true;
    });
  });

  // Check if the Docker image exists when Docker mode is enabled (debounced)
  let checkTimer: ReturnType<typeof setTimeout>;
  createEffect(() => {
    if (!dockerMode() || !store.dockerAvailable) {
      clearTimeout(checkTimer);
      setDockerImageReady(null);
      return;
    }

    const projDocker = projectDockerfile();
    const image = projDocker ? projDocker.imageTag : store.dockerImage || DEFAULT_DOCKER_IMAGE;
    const checkArgs: Record<string, string> = { image };
    if (projDocker) checkArgs.dockerfilePath = projDocker.dockerfilePath;

    let cancelled = false;
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => {
      invoke<boolean>(IPC.CheckDockerImageExists, checkArgs).then(
        (exists) => {
          if (!cancelled) setDockerImageReady(exists);
        },
        () => {
          if (!cancelled) setDockerImageReady(false);
        },
      );
    }, 300);

    onCleanup(() => {
      cancelled = true;
      clearTimeout(checkTimer);
    });
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
      const projDocker = projectDockerfile();
      const buildArgs: Record<string, string> = { onOutputChannel: `channel:${channelId}` };
      if (projDocker) {
        buildArgs.dockerfilePath = projDocker.dockerfilePath;
        buildArgs.imageTag = projDocker.imageTag;
        buildArgs.buildContext = projDocker.buildContext;
      }
      const result = await invoke<{ ok: boolean; error?: string }>(IPC.BuildDockerImage, buildArgs);
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
          try {
            await invoke(IPC.CheckoutBranch, {
              projectRoot: projectPath,
              branchName: baseBranch(),
            });
          } catch (err) {
            setError(
              `Cannot switch to "${baseBranch()}": ${err instanceof Error ? err.message : String(err)}`,
            );
            return;
          }
        }
      }

      const projDocker = projectDockerfile();
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
        stepsEnabled: stepsEnabled(),
        skipPermissions: agentSupportsSkipPermissions() && skipPermissions(),
        dockerMode: dockerMode() || undefined,
        dockerSource: dockerMode()
          ? projDocker
            ? 'project'
            : store.dockerImage && store.dockerImage !== DEFAULT_DOCKER_IMAGE
              ? 'custom'
              : 'default'
          : undefined,
        dockerImage: dockerMode()
          ? (projDocker?.imageTag ?? (store.dockerImage || DEFAULT_DOCKER_IMAGE))
          : undefined,
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
    <Dialog
      open={props.open}
      onClose={props.onClose}
      width={store.availableAgents.length > 8 ? '620px' : '520px'}
      panelStyle={{ gap: '20px' }}
    >
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
              margin: '0',
              'font-size': '17px',
              color: theme.fg,
              'font-weight': '600',
            }}
          >
            New Task
          </h2>
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
              'font-size': '14px',
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
              'font-size': '14px',
              outline: 'none',
            }}
          />
          <Show when={gitIsolation() === 'direct' && selectedProjectPath()}>
            <div
              style={{
                'font-size': '12px',
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

        {/* Isolation mode selector */}
        <div
          data-nav-field="git-isolation"
          style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
        >
          <label style={sectionLabelStyle}>Git Isolation</label>
          <SegmentedButtons
            options={[
              {
                value: 'worktree',
                label: 'Worktree',
                title:
                  'Creates a git branch and worktree so the AI agent can work in isolation without affecting your current branch.',
              },
              {
                value: 'direct',
                label: 'Current Branch',
                disabled: directDisabled(),
                title: 'The AI agent will work on your current branch in the project root.',
              },
            ]}
            value={gitIsolation()}
            onChange={setGitIsolation}
          />
          <Show when={directDisabled()}>
            <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
              This project already has a task on the current branch
            </span>
          </Show>
          <Show when={gitIsolation() === 'direct'}>
            <div style={{ ...bannerStyle(theme.warning), 'font-size': '13px' }}>
              Changes will be made on the selected branch without worktree isolation.
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
            <Show when={branchesLoading()}>
              {' '}
              <span
                class="inline-spinner"
                aria-hidden="true"
                style={{ 'vertical-align': 'middle' }}
              />
            </Show>
          </label>
          <select
            class="input-field"
            value={baseBranch()}
            onChange={(e) => setBaseBranch(e.currentTarget.value)}
            disabled={branchesLoading()}
            style={{
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              padding: '10px 14px',
              color: theme.fg,
              'font-size': '14px',
              'font-family': "'JetBrains Mono', monospace",
              outline: 'none',
              opacity: branchesLoading() ? '0.5' : '1',
            }}
          >
            <For each={branches()}>{(b) => <option value={b}>{b}</option>}</For>
          </select>
        </div>

        {/* Checkboxes group */}
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
          {/* Steps tracking toggle */}
          <div data-nav-field="steps-enabled">
            <label
              title="Instructs the agent to append progress entries to .claude/steps.json. Each entry is shown live in the Steps panel as the agent works."
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '8px',
                'font-size': '13px',
                color: theme.fg,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={stepsEnabled()}
                onChange={(e) => setStepsEnabled(e.currentTarget.checked)}
                style={{ 'accent-color': theme.accent, cursor: 'inherit' }}
              />
              Steps tracking
            </label>
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
                  'font-size': '13px',
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
                    'font-size': '13px',
                  }}
                >
                  The agent will run without asking for confirmation. It can read, write, and delete
                  files, and execute commands without your approval.
                </div>
                <Show when={!dockerMode() && store.dockerAvailable}>
                  <div style={{ 'font-size': '12px', color: theme.fgMuted }}>
                    Tip: Enable Docker isolation to limit the blast radius of skip-permissions mode.
                  </div>
                </Show>
                <Show when={!store.dockerAvailable}>
                  <div style={{ 'font-size': '12px', color: theme.fgMuted }}>
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
                  'font-size': '13px',
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
                    'font-size': '13px',
                    color: theme.success ?? theme.accent,
                    background: `color-mix(in srgb, ${theme.success ?? theme.accent} 8%, transparent)`,
                    padding: '8px 12px',
                    'border-radius': '8px',
                    border: `1px solid color-mix(in srgb, ${theme.success ?? theme.accent} 20%, transparent)`,
                  }}
                >
                  The agent will run inside a Docker container. Only the project directory is
                  mounted — files outside the project are protected from accidental deletion.
                </div>
                <Show when={projectDockerfile()}>
                  <div
                    style={{
                      'font-size': '12px',
                      color: theme.accent,
                      display: 'flex',
                      'align-items': 'center',
                      gap: '4px',
                    }}
                  >
                    <span aria-hidden="true">📁</span>
                    Using project Dockerfile:{' '}
                    <code style={{ 'font-family': "'JetBrains Mono', monospace" }}>
                      {PROJECT_DOCKERFILE_RELATIVE_PATH}
                    </code>
                  </div>
                </Show>
                <Show when={!projectDockerfile()}>
                  <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                    <label
                      style={{ 'font-size': '12px', color: theme.fgMuted, 'white-space': 'nowrap' }}
                    >
                      Image:
                    </label>
                    <input
                      type="text"
                      value={store.dockerImage}
                      onInput={(e) => setDockerImage(e.currentTarget.value)}
                      placeholder={DEFAULT_DOCKER_IMAGE}
                      style={{
                        flex: '1',
                        background: theme.bgInput,
                        border: `1px solid ${theme.border}`,
                        'border-radius': '6px',
                        padding: '5px 10px',
                        color: theme.fg,
                        'font-size': '13px',
                        'font-family': "'JetBrains Mono', monospace",
                        outline: 'none',
                      }}
                    />
                  </div>
                </Show>
                <Show when={dockerImageReady() === false && !dockerBuilding()}>
                  <div
                    style={{
                      display: 'flex',
                      'align-items': 'center',
                      gap: '8px',
                      'font-size': '12px',
                      color: theme.fgMuted,
                    }}
                  >
                    <span>Image not found locally.</span>
                    <Show
                      when={
                        projectDockerfile() ||
                        store.dockerImage === DEFAULT_DOCKER_IMAGE ||
                        !store.dockerImage
                      }
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
                          'font-size': '12px',
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
                      'font-size': '12px',
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
                        'font-size': '11px',
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
                  <div style={{ 'font-size': '12px', color: theme.error }}>
                    Build failed: {dockerBuildError()}
                  </div>
                </Show>
                <Show when={dockerImageReady() === true && !dockerBuilding()}>
                  <div style={{ 'font-size': '12px', color: theme.success ?? theme.accent }}>
                    {projectDockerfile() ? 'Project image ready.' : 'Image ready.'}
                  </div>
                </Show>
              </Show>
            </div>
          </Show>
        </div>
        {/* end checkboxes group */}

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
              'font-size': '13px',
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
              'font-size': '14px',
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
              'font-size': '14px',
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
