import {
  createSignal,
  createEffect,
  createMemo,
  createUniqueId,
  Show,
  onCleanup,
  on,
  untrack,
} from 'solid-js';
import type { JSX } from 'solid-js';
import { Dialog } from './Dialog';
import { FolderIcon, GitBranchIcon } from './icons';
import { ConfirmDialog } from './ConfirmDialog';
import { errMessage } from '../lib/log';
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
  projectIsGitRepo,
  getGitHubDropDefaults,
  setPrefillPrompt,
  setDockerAvailable,
  setDockerImage,
} from '../store/store';
import type { GitIsolationMode } from '../store/types';
import {
  toBranchName,
  sanitizeBranchPrefix,
  findBranchPrefixConflict,
  branchPrefixConflictError,
} from '../lib/branch-name';
import { SegmentedButtons } from './SegmentedButtons';
import { autoTaskNameFromPrompt, nextDefaultTaskName } from '../lib/clean-task-name';
import { extractGitHubUrl } from '../lib/github-url';
import {
  createSymlinkCandidateState,
  shouldProbeSymlinkCandidates,
  symlinkProbeBlocksSubmit,
} from '../lib/symlink-candidates';
import { theme, sectionLabelStyle, bannerStyle } from '../lib/theme';
import { isMac } from '../lib/platform';
import { AgentSelector } from './AgentSelector';
import { BranchPrefixField } from './BranchPrefixField';
import { BranchCombobox } from './BranchCombobox';
import { ProjectSelect } from './ProjectSelect';
import { SymlinkDirPicker } from './SymlinkDirPicker';
import { scrollCoordinatorIntoView } from './scrollCoordinatorIntoView';
import type { AgentDef, GitIgnoredEntry } from '../ipc/types';
import { DEFAULT_DOCKER_IMAGE, PROJECT_DOCKERFILE_RELATIVE_PATH } from '../lib/docker';
import {
  clampCoordinatorConcurrentTasks,
  DEFAULT_COORDINATOR_CONCURRENT_TASKS,
  MAX_COORDINATOR_CONCURRENT_TASKS,
  MIN_COORDINATOR_CONCURRENT_TASKS,
} from '../lib/coordinator-limits';

interface NewTaskDialogProps {
  open: boolean;
  onClose: () => void;
}

export function CheckboxOption(props: {
  label: JSX.Element;
  checked: boolean;
  onChange: (checked: boolean) => void;
  title?: string;
  disabled?: boolean;
  paddingLeft?: string;
}) {
  return (
    <label
      title={props.title}
      style={{
        display: 'flex',
        'align-items': 'center',
        gap: '8px',
        'font-size': '13px',
        color: theme.fg,
        cursor: props.disabled ? 'not-allowed' : 'pointer',
        'padding-left': props.paddingLeft,
      }}
    >
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => !props.disabled && props.onChange(e.currentTarget.checked)}
        style={{
          'accent-color': theme.accent,
          cursor: props.disabled ? 'not-allowed' : 'inherit',
          opacity: props.disabled ? '0.5' : '1',
        }}
      />
      {props.label}
    </label>
  );
}

export function InlineBanner(props: { color: string; children: JSX.Element; fontSize?: string }) {
  return (
    <div
      style={{
        ...bannerStyle(props.color),
        'font-size': props.fontSize ?? '13px',
      }}
    >
      {props.children}
    </div>
  );
}

interface ProjectDockerfileInfo {
  dockerfilePath: string;
  imageTag: string;
  buildContext: string;
}

function DockerTaskOptions(props: {
  dockerMode: boolean;
  setDockerMode: (enabled: boolean) => void;
  coordinatorMode: boolean;
  projectDockerfile: ProjectDockerfileInfo | null;
  dockerImageReady: boolean | null;
  dockerBuilding: boolean;
  dockerBuildOutput: string;
  dockerBuildError: string;
  setBuildOutputRef: (el: HTMLPreElement) => void;
  onBuildImage: () => void;
}) {
  return (
    <Show when={store.dockerAvailable}>
      <div
        data-nav-field="docker-mode"
        style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
      >
        <CheckboxOption
          label="Run in Docker container"
          checked={props.dockerMode}
          onChange={props.setDockerMode}
        />
        <Show when={props.dockerMode}>
          <InlineBanner color={theme.success ?? theme.accent}>
            <>
              The agent will run inside a Docker container. Only the project directory is mounted —
              files outside the project are protected from accidental deletion.
              <Show when={store.shareDockerAgentAuth}>
                {' '}
                Agent credentials are shared across containers.
              </Show>
            </>
          </InlineBanner>
          <Show when={props.coordinatorMode && isMac}>
            <InlineBanner color={theme.warning} fontSize="12px">
              Coordinator + Docker on macOS: the MCP server binds to all network interfaces so
              sub-task containers can reach it via host.docker.internal. The port is reachable from
              other hosts on your local network (token-protected).
            </InlineBanner>
          </Show>
          <Show when={props.projectDockerfile}>
            <div
              style={{
                'font-size': '12px',
                color: theme.accent,
                display: 'flex',
                'align-items': 'center',
                gap: '4px',
              }}
            >
              <FolderIcon size={12} />
              Using project Dockerfile:{' '}
              <code style={{ 'font-family': "'JetBrains Mono', monospace" }}>
                {PROJECT_DOCKERFILE_RELATIVE_PATH}
              </code>
            </div>
          </Show>
          <Show when={!props.projectDockerfile}>
            <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
              <label style={{ 'font-size': '12px', color: theme.fgMuted, 'white-space': 'nowrap' }}>
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
                  'border-radius': 'var(--radius-sm)',
                  padding: '5px 10px',
                  color: theme.fg,
                  'font-size': '13px',
                  'font-family': "'JetBrains Mono', monospace",
                  outline: 'none',
                }}
              />
            </div>
          </Show>
          <Show when={props.dockerImageReady === false && !props.dockerBuilding}>
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
                  props.projectDockerfile ||
                  store.dockerImage === DEFAULT_DOCKER_IMAGE ||
                  !store.dockerImage
                }
              >
                <button
                  type="button"
                  onClick={() => props.onBuildImage()}
                  style={{
                    background: theme.accent,
                    color: theme.accentText,
                    border: 'none',
                    'border-radius': 'var(--radius-xs)',
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
          <Show when={props.dockerBuilding}>
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
            <Show when={props.dockerBuildOutput}>
              <pre
                ref={props.setBuildOutputRef}
                style={{
                  'font-size': '11px',
                  color: theme.fgSubtle,
                  background: theme.bgInput,
                  'border-radius': 'var(--radius-xs)',
                  padding: '6px 8px',
                  'max-height': '120px',
                  'overflow-y': 'auto',
                  'white-space': 'pre-wrap',
                  'word-break': 'break-all',
                  margin: '0',
                }}
              >
                {props.dockerBuildOutput}
              </pre>
            </Show>
          </Show>
          <Show when={props.dockerBuildError}>
            <div style={{ 'font-size': '12px', color: theme.error }}>
              Build failed: {props.dockerBuildError}
            </div>
          </Show>
          <Show when={props.dockerImageReady === true && !props.dockerBuilding}>
            <div style={{ 'font-size': '12px', color: theme.success ?? theme.accent }}>
              {props.projectDockerfile ? 'Project image ready.' : 'Image ready.'}
            </div>
          </Show>
        </Show>
      </div>
    </Show>
  );
}

function CoordinatorTaskOptions(props: {
  coordinatorMode: boolean;
  setCoordinatorMode: (enabled: boolean) => void;
  hasActiveCoordinator: boolean;
  agentSupportsSkipPermissions: boolean;
  skipPermissions: boolean;
  propagateSkipPermissions: boolean;
  setPropagateSkipPermissions: (enabled: boolean) => void;
  maxConcurrentTasks: number;
  setMaxConcurrentTasks: (value: number) => void;
}) {
  return (
    <Show when={store.coordinatorModeEnabled}>
      <div
        data-nav-field="coordinator-mode"
        style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
      >
        <CheckboxOption
          label="Coordinator mode"
          checked={props.coordinatorMode}
          disabled={props.hasActiveCoordinator}
          onChange={props.setCoordinatorMode}
          title={
            props.hasActiveCoordinator
              ? 'Only one coordinator per project can be active at a time'
              : undefined
          }
        />
        <Show when={props.coordinatorMode}>
          <InlineBanner color={theme.warning} fontSize="12px">
            This agent will be able to create tasks, send prompts, and merge branches automatically
            via MCP tools. The remote server will be started automatically.
          </InlineBanner>
          <label
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '8px',
              'font-size': '13px',
              color: theme.fg,
              'padding-left': '4px',
            }}
          >
            Max concurrent sub-tasks:
            <input
              type="number"
              min={MIN_COORDINATOR_CONCURRENT_TASKS}
              max={MAX_COORDINATOR_CONCURRENT_TASKS}
              value={props.maxConcurrentTasks}
              onInput={(e) => {
                const v = parseInt(e.currentTarget.value, 10);
                if (!isNaN(v)) props.setMaxConcurrentTasks(clampCoordinatorConcurrentTasks(v));
              }}
              style={{
                width: '60px',
                background: theme.bgInput,
                color: theme.fg,
                border: `1px solid ${theme.border}`,
                'border-radius': 'var(--radius-sm)',
                padding: '4px 8px',
                'font-size': '13px',
              }}
            />
          </label>
          <Show when={props.agentSupportsSkipPermissions && props.skipPermissions}>
            <CheckboxOption
              label="Propagate skip-permissions to sub-tasks"
              checked={props.propagateSkipPermissions}
              onChange={props.setPropagateSkipPermissions}
              paddingLeft="4px"
            />
            <Show when={props.propagateSkipPermissions}>
              <InlineBanner color={theme.warning} fontSize="12px">
                <>
                  All sub-tasks created by this coordinator will inherit{' '}
                  <strong>--dangerously-skip-permissions</strong> and run without confirmation
                  prompts.
                </>
              </InlineBanner>
            </Show>
          </Show>
        </Show>
      </div>
    </Show>
  );
}

export function NewTaskDialog(props: NewTaskDialogProps) {
  const [prompt, setPrompt] = createSignal('');
  // Prompt/name values right after open/prefill — closing is only guarded when
  // the user has typed something beyond them.
  const [initialPrompt, setInitialPrompt] = createSignal('');
  const [initialName, setInitialName] = createSignal('');
  const [confirmDiscard, setConfirmDiscard] = createSignal(false);
  const [name, setName] = createSignal('');
  const [selectedAgent, setSelectedAgent] = createSignal<AgentDef | null>(null);
  const [selectedProjectId, setSelectedProjectId] = createSignal<string | null>(null);
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const symlinkCandidates = createSymlinkCandidateState((projectRoot) =>
    invoke<GitIgnoredEntry[]>(IPC.GetGitignoredDirs, { projectRoot }),
  );
  const [gitIsolation, setGitIsolation] = createSignal<GitIsolationMode>('worktree');
  const [baseBranch, setBaseBranch] = createSignal('');
  const [branches, setBranches] = createSignal<string[]>([]);
  const [branchesLoading, setBranchesLoading] = createSignal(false);
  const [branchesError, setBranchesError] = createSignal(false);
  // Bumped by the Retry button to re-run the branch-fetch effect.
  const [branchRetryToken, setBranchRetryToken] = createSignal(0);
  const [stepsEnabled, setStepsEnabled] = createSignal(store.defaultStepsEnabled);
  const [skipPermissions, setSkipPermissions] = createSignal(store.defaultSkipPermissions);
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
  const [coordinatorMode, setCoordinatorMode] = createSignal(false);
  const [propagateSkipPermissions, setPropagateSkipPermissions] = createSignal(
    store.defaultPropagateSkipPermissions,
  );
  const [maxConcurrentTasks, setMaxConcurrentTasks] = createSignal(
    DEFAULT_COORDINATOR_CONCURRENT_TASKS,
  );
  const hasActiveCoordinator = () =>
    Object.values(store.tasks).some(
      (t) => t.coordinatorMode && !t.closingStatus && t.projectId === selectedProjectId(),
    );
  createEffect(() => {
    selectedProjectId();
    if (hasActiveCoordinator()) {
      setCoordinatorMode(false);
    }
  });
  const [branchPrefix, setBranchPrefix] = createSignal('');
  let promptRef!: HTMLTextAreaElement;
  const titleId = createUniqueId();
  const branchInputId = createUniqueId();
  let formRef!: HTMLFormElement;
  let buildOutputRef!: HTMLPreElement;
  let scrollContainerRef!: HTMLDivElement;

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

  // Initialize state each time the dialog opens.  Wrapped in on() so the
  // effect only re-fires on the props.open *transition*, not whenever any
  // store default mutates while the dialog is already open (e.g. the user
  // toggling Settings, or autosave restoring state).  untrack() ensures the
  // store reads inside are one-shot samples, not new reactive subscriptions.
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        untrack(() => {
          setStepsEnabled(store.defaultStepsEnabled);
          setSkipPermissions(store.defaultSkipPermissions);
          setPropagateSkipPermissions(store.defaultPropagateSkipPermissions);
        });
      },
      { defer: true },
    ),
  );

  // Initialize remaining state each time the dialog opens.  Same on()+untrack
  // guard as the effect above: fire only on the props.open *transition* and
  // untrack the body, so no store read — nor the prompt/name snapshot below —
  // subscribes the effect. Otherwise a tracked read (e.g. the synchronous
  // prompt()/name() reads when agents are cached, or store.availableAgents
  // changing while open) would re-fire this effect and reset the fields via
  // setPrompt('')/setName('') mid-typing.
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        untrack(() => {
          // Reset signals for a fresh dialog
          setPrompt('');
          setInitialPrompt('');
          setInitialName('');
          setConfirmDiscard(false);
          setName('');
          setError('');
          setLoading(false);
          setGitIsolation('worktree');
          setDockerMode(false);
          setDockerImageReady(null);
          setDockerBuilding(false);
          setDockerBuildOutput('');
          setDockerBuildError('');
          setProjectDockerfile(null);
          setCoordinatorMode(false);

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
            // Snapshot the post-prefill values as the close-guard baseline.
            setInitialPrompt(prompt());
            setInitialName(name());

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
      },
      { defer: true },
    ),
  );

  // Fetch gitignored dirs whenever the dialog opens or the project changes.
  // Reading props.open makes the list reload on every open, so cancelling and
  // reopening always starts from the default selection — each task's symlink
  // choices are an explicit opt-in. The candidate state clears itself before
  // fetching and drops stale responses, so a previous project's checkmarks
  // can never leak into the next one. Reading gitIsolation makes the probe
  // re-run when the mode changes; direct-mode tasks never send symlinkDirs,
  // so no probe is issued for them at all.
  createEffect(() => {
    const open = props.open;
    const pid = selectedProjectId();
    const path = open && pid ? getProjectPath(pid) : undefined;
    const isGit = pid ? projectIsGitRepo(pid) : true;
    const shouldProbe = shouldProbeSymlinkCandidates(isGit, gitIsolation());

    void symlinkCandidates.load(path, shouldProbe);

    onCleanup(() => {
      symlinkCandidates.invalidate();
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
    // Read the retry token so the Retry button can re-run this effect.
    branchRetryToken();
    let cancelled = false;

    const isGit = pid ? projectIsGitRepo(pid) : true;

    if (!open || !projectPath || !isGit) {
      setBranches([]);
      setBaseBranch('');
      setBranchesLoading(false);
      setBranchesError(false);
      // D-03: onCleanup registered synchronously even on early return
      onCleanup(() => {
        cancelled = true;
      });
      return;
    }

    // D-01: Clear list and show spinner immediately on every open. Also clear
    // the committed branch so the combobox does not display the previous
    // project's branch as the current value during the fetch window.
    setBranches([]);
    setBaseBranch('');
    setBranchesLoading(true);
    setBranchesError(false);

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
        // Inline error + Retry surfaces this in the dialog; no toast needed.
        // Keep the detail in the console for diagnostics.
        setBranchesError(true);
        console.error('Failed to load branches:', err);
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
    if (!projectIsGitRepo(pid)) {
      setGitIsolation('none');
      return;
    }
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

  // When the user enables coordinator mode, scroll the form to the bottom so
  // the newly-revealed options (max tasks, propagate, symlinks) are visible.
  // defer:true skips the initial run so we only scroll on user-initiated toggles.
  // queueMicrotask waits for Solid to insert the <Show> block before measuring scrollHeight.
  createEffect(
    on(
      coordinatorMode,
      (enabled) => {
        queueMicrotask(() => scrollCoordinatorIntoView(enabled, scrollContainerRef));
      },
      { defer: true },
    ),
  );

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

  // Name derived from what the user typed: the trimmed name, else a concise
  // name from the prompt. Empty when neither is provided.
  const effectiveName = () => {
    const n = name().trim();
    if (n) return n;
    const p = prompt().trim();
    if (!p) return '';
    // Keep the stored task/worktree name concise; the title bar can render a longer label.
    return autoTaskNameFromPrompt(p);
  };

  // Name actually used to create the task. Falls back to "Task N" so a task can
  // be created with neither a prompt nor a typed name.
  const resolvedName = () =>
    effectiveName() || nextDefaultTaskName(Object.values(store.tasks).map((t) => t.name));

  const branchPreview = () => {
    const prefix = sanitizeBranchPrefix(branchPrefix());
    return `${prefix}/${toBranchName(resolvedName())}`;
  };

  const branchPrefixConflict = createMemo(() => {
    if (gitIsolation() !== 'worktree') return null;
    return findBranchPrefixConflict(branchPrefix(), branches());
  });

  const branchPrefixError = createMemo(() => {
    const c = branchPrefixConflict();
    return c ? branchPrefixConflictError(c) : '';
  });

  const selectedProjectPath = () => {
    const pid = selectedProjectId();
    return pid ? getProjectPath(pid) : undefined;
  };

  const isNonGitProject = () => {
    const pid = selectedProjectId();
    return pid ? !projectIsGitRepo(pid) : false;
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
    // No name/prompt requirement — an empty task defaults to "Task N".
    // Block submit while branches load — and require a resolved base branch
    // for git projects — so a task can't be created with a stale or empty
    // base branch (e.g. after a failed branch fetch).
    const branchOk = isNonGitProject() || (!!baseBranch() && !branchesError());
    return (
      !!selectedProjectId() &&
      !loading() &&
      !branchesLoading() &&
      // Block submit until the symlink candidate list for THIS project has
      // resolved — otherwise stale checkmarks could be submitted against a
      // project whose candidates haven't loaded yet. Direct-mode submits
      // never send symlinkDirs, so a pending probe doesn't block them.
      !symlinkProbeBlocksSubmit(gitIsolation(), symlinkCandidates.loading()) &&
      branchOk &&
      !branchPrefixConflict()
    );
  };

  async function handleSubmit(e: Event) {
    e.preventDefault();
    const manualName = name().trim();
    const n = resolvedName();

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
    if (coordinatorMode() && hasActiveCoordinator()) {
      setError('Only one coordinator per project can be active at a time');
      return;
    }

    const p = prompt().trim() || undefined;
    const isFromDrop = !!store.newTaskDropUrl;
    const prefix = sanitizeBranchPrefix(branchPrefix());
    const prefixConflict = branchPrefixConflict();
    if (prefixConflict) {
      setError(branchPrefixConflictError(prefixConflict));
      return;
    }
    const ghUrl = (p ? extractGitHubUrl(p) : null) ?? store.newTaskDropUrl ?? undefined;

    setLoading(true);
    setError('');

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
            setError(`Cannot switch to "${baseBranch()}": ${errMessage(err)}`);
            return;
          }
        }
      }

      const projDocker = projectDockerfile();
      const taskId = await createTask({
        name: n,
        nameIsAutoGenerated: !manualName,
        agentDef: agent,
        projectId,
        gitIsolation: gitIsolation(),
        baseBranch: baseBranch(),
        symlinkDirs: gitIsolation() === 'worktree' ? [...symlinkCandidates.selected()] : undefined,
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
        coordinatorMode: coordinatorMode() || undefined,
        propagateSkipPermissions:
          coordinatorMode() && agentSupportsSkipPermissions() && skipPermissions()
            ? propagateSkipPermissions()
            : undefined,
        maxConcurrentTasks: coordinatorMode()
          ? clampCoordinatorConcurrentTasks(maxConcurrentTasks())
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

  // Guard against a misclick on the overlay (or Escape/Cancel) silently
  // discarding a typed prompt or task name — state is reset on next open.
  function requestClose() {
    const dirty =
      prompt().trim() !== initialPrompt().trim() || name().trim() !== initialName().trim();
    if (dirty) {
      setConfirmDiscard(true);
    } else {
      props.onClose();
    }
  }

  return (
    <Dialog
      open={props.open}
      onClose={requestClose}
      width={store.availableAgents.length > 8 ? 'min(840px, calc(100vw - 48px))' : '560px'}
      labelledBy={titleId}
      panelStyle={{ padding: '0', overflow: 'hidden', gap: '0' }}
    >
      <form
        ref={formRef}
        class="new-task-dialog-form"
        onSubmit={handleSubmit}
        style={{
          display: 'flex',
          'flex-direction': 'column',
          'min-height': '0',
          overflow: 'hidden',
        }}
      >
        <div
          ref={scrollContainerRef}
          style={{
            'overflow-y': 'auto',
            'min-height': '0',
            flex: '1 1 auto',
            display: 'flex',
            'flex-direction': 'column',
            gap: '20px',
            padding: '28px 28px 20px',
          }}
        >
          <div>
            <h2
              id={titleId}
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
              placeholder={
                coordinatorMode()
                  ? 'Example: Work through the items in /path/to/todos.md. Only work from that file. Use <branch> as the baseBranch for all sub-tasks.'
                  : 'What should the agent work on?'
              }
              rows={3}
              style={{
                background: theme.bgInput,
                border: `1px solid ${theme.border}`,
                'border-radius': 'var(--radius-md)',
                padding: '10px 14px',
                color: theme.fg,
                'font-size': '14px',
                'font-family': 'var(--font-mono)',
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
              placeholder={resolvedName()}
              style={{
                background: theme.bgInput,
                border: `1px solid ${theme.border}`,
                'border-radius': 'var(--radius-md)',
                padding: '10px 14px',
                color: theme.fg,
                'font-size': '14px',
                outline: 'none',
              }}
            />
            <Show when={gitIsolation() === 'direct' && !isNonGitProject() && selectedProjectPath()}>
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
                  <GitBranchIcon size={11} style={{ 'flex-shrink': '0' }} />
                  main branch (detected on create)
                </span>
                <span style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
                  <FolderIcon size={11} style={{ 'flex-shrink': '0' }} />
                  {selectedProjectPath()}
                </span>
              </div>
            </Show>
          </div>

          <Show when={gitIsolation() === 'worktree'}>
            <BranchPrefixField
              branchPrefix={branchPrefix()}
              branchPreview={branchPreview()}
              error={branchPrefixError()}
              projectPath={selectedProjectPath()}
              onPrefixChange={setBranchPrefix}
            />
          </Show>

          <AgentSelector
            agents={store.availableAgents}
            selectedAgent={selectedAgent()}
            onSelect={setSelectedAgent}
            wrap={false}
          />

          {/* Isolation mode selector — hidden for non-git projects */}
          <Show when={!isNonGitProject()}>
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
          </Show>

          {/* Branch picker — hidden for non-git projects */}
          <Show when={!isNonGitProject()}>
            <div
              data-nav-field="base-branch"
              style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
            >
              {/* On a load failure the combobox is unmounted, so only point
                  the label at it while it is actually rendered. */}
              <label
                for={branchesError() ? undefined : branchInputId}
                style={{ ...sectionLabelStyle, 'align-self': 'flex-start' }}
              >
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
              {/* On a load failure, swap the empty picker for the error +
                  Retry — an empty combobox reading "No matching branches"
                  would misrepresent a fetch failure as an empty repo. */}
              <Show
                when={!branchesError()}
                fallback={
                  <div
                    role="alert"
                    style={{
                      display: 'flex',
                      'align-items': 'center',
                      gap: '8px',
                      'font-size': '12px',
                      color: theme.error,
                    }}
                  >
                    <span>Couldn't load branches.</span>
                    <button
                      type="button"
                      onClick={() => setBranchRetryToken((n) => n + 1)}
                      style={{
                        background: 'transparent',
                        border: `1px solid ${theme.border}`,
                        'border-radius': 'var(--radius-sm)',
                        padding: '3px 10px',
                        color: theme.fg,
                        'font-size': '12px',
                        cursor: 'pointer',
                      }}
                    >
                      Retry
                    </button>
                  </div>
                }
              >
                <BranchCombobox
                  id={branchInputId}
                  branches={branches()}
                  value={baseBranch()}
                  onChange={setBaseBranch}
                  loading={branchesLoading()}
                />
              </Show>
            </div>
          </Show>

          {/* Checkboxes group */}
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
            <div data-nav-field="steps-enabled">
              <CheckboxOption
                title="Instructs the agent to append progress entries to .claude/steps.json. Each entry is shown live in the Steps panel as the agent works."
                label="Steps tracking"
                checked={stepsEnabled()}
                onChange={setStepsEnabled}
              />
            </div>

            <Show when={agentSupportsSkipPermissions()}>
              <div
                data-nav-field="skip-permissions"
                style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
              >
                <CheckboxOption
                  label="Dangerously skip all confirms"
                  checked={skipPermissions()}
                  onChange={setSkipPermissions}
                />
                <Show when={skipPermissions()}>
                  <InlineBanner color={theme.warning}>
                    The agent will run without asking for confirmation. It can read, write, and
                    delete files, and execute commands without your approval.
                  </InlineBanner>
                  <Show when={!dockerMode() && store.dockerAvailable}>
                    <div style={{ 'font-size': '12px', color: theme.fgMuted }}>
                      Tip: Enable Docker isolation to limit the blast radius of skip-permissions
                      mode.
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

            <DockerTaskOptions
              dockerMode={dockerMode()}
              setDockerMode={setDockerMode}
              coordinatorMode={coordinatorMode()}
              projectDockerfile={projectDockerfile()}
              dockerImageReady={dockerImageReady()}
              dockerBuilding={dockerBuilding()}
              dockerBuildOutput={dockerBuildOutput()}
              dockerBuildError={dockerBuildError()}
              setBuildOutputRef={(el) => {
                buildOutputRef = el;
              }}
              onBuildImage={handleBuildImage}
            />
          </div>
          {/* end checkboxes group */}

          {/* Coordinator mode toggle — below skip-permissions so enabling skip-perms
              doesn't cause items to appear above the checkbox you just clicked */}
          <CoordinatorTaskOptions
            coordinatorMode={coordinatorMode()}
            setCoordinatorMode={setCoordinatorMode}
            hasActiveCoordinator={hasActiveCoordinator()}
            agentSupportsSkipPermissions={agentSupportsSkipPermissions()}
            skipPermissions={skipPermissions()}
            propagateSkipPermissions={propagateSkipPermissions()}
            setPropagateSkipPermissions={setPropagateSkipPermissions}
            maxConcurrentTasks={maxConcurrentTasks()}
            setMaxConcurrentTasks={setMaxConcurrentTasks}
          />

          <Show when={symlinkCandidates.dirs().length > 0 && gitIsolation() === 'worktree'}>
            <SymlinkDirPicker
              dirs={symlinkCandidates.dirs()}
              selectedDirs={symlinkCandidates.selected()}
              onToggle={symlinkCandidates.toggle}
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
        </div>

        <div
          data-nav-field="footer"
          style={{
            display: 'flex',
            gap: '8px',
            'justify-content': 'flex-end',
            padding: '16px 28px',
            'border-top': `1px solid ${theme.border}`,
            background: theme.islandBg,
            'flex-shrink': '0',
          }}
        >
          <button
            type="button"
            class="btn-secondary"
            onClick={() => requestClose()}
            style={{
              padding: '9px 18px',
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              'border-radius': 'var(--radius-md)',
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
              'border-radius': 'var(--radius-md)',
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
      <ConfirmDialog
        open={confirmDiscard()}
        title="Discard draft?"
        message="Closing will discard what you typed."
        confirmLabel="Discard"
        danger
        onConfirm={() => {
          setConfirmDiscard(false);
          props.onClose();
        }}
        onCancel={() => {
          setConfirmDiscard(false);
          promptRef?.focus();
        }}
      />
    </Dialog>
  );
}
