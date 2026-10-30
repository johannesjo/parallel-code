import { taskProjectFilter } from '../store/task-project-filter';
import { createCanvasTask, validateCanvasTaskSource } from '../store/canvas-tasks';
import type { AppStore, KanbanNewTaskSource, SpNewTaskSource } from '../store/types';
import { linkNewTaskToSp } from '../store/superProductivityOpen';
import { linkNewTaskToKanbanCard } from '../store/kanban';
import { removeTaskIdea } from '../store/ideas';
import { nameTaskWithModel } from '../store/model-task-name';
import { activeFeatureHint, markFeatureHintSeen } from '../store/onboarding';
import { createTaskInBackground, registerOpenDraft } from '../store/task-creation';
import type { CreateTaskOptions } from '../store/tasks';
import {
  createSignal,
  createEffect,
  createMemo,
  createUniqueId,
  Show,
  onCleanup,
  onMount,
  on,
  untrack,
} from 'solid-js';
import type { JSX } from 'solid-js';
import { createFocusRestore } from '../lib/focus-restore';
import { topDialog } from '../lib/dialog-stack';
import { registerFocusFn, unregisterFocusFn } from '../store/focused-panel';
import { setStore } from '../store/core';
import { ContainerIcon, FolderIcon, GitBranchIcon, GitHubIcon, PlusIcon, SyncIcon } from './icons';
import { ConfirmDialog } from './ConfirmDialog';
import { errMessage } from '../lib/log';
import { withViewTransition } from '../lib/viewTransition';
import { invoke } from '../lib/ipc';
import { dataTransferToShellArgs } from '../lib/terminalDrop';
import { IPC } from '../../electron/ipc/channels';
import { resolveSkipPermissionsArgs } from '../../electron/shared/skip-permissions';
import {
  store,
  createTask,
  toggleNewTaskPanel,
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
  codeProjects,
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
import { isAgentInstalled, pickDefaultAgent } from '../lib/default-agent';
import { extractGitHubUrl } from '../lib/github-url';
import { parseClaudeSessionUrl } from '../lib/claude-session-url';
import { sessionAgentForCommand } from '../../electron/shared/session-record';
import { buildIssuePrompt, buildPrTaskPrompt, workItemTaskName } from '../lib/github-prompts';
import { getGitHubIssue } from '../store/github';
import { linkTaskToIssueReference } from '../store/github-issue-link';
import { GitHubItemPicker } from './GitHubItemPicker';
import {
  createSymlinkCandidateState,
  shouldProbeSymlinkCandidates,
  symlinkProbeBlocksSubmit,
} from '../lib/symlink-candidates';
import { theme, sectionLabelStyle, bannerStyle } from '../lib/theme';
import { isMac } from '../lib/platform';
import { AgentSelector } from './AgentSelector';
import { NewTaskModelPicker, modelProvider } from './NewTaskModelPicker';
import { reviewerWithModel } from '../lib/agent-handoff';
import { FeatureHint } from './FeatureHint';
import { BranchPrefixField } from './BranchPrefixField';
import { BranchCombobox } from './BranchCombobox';
import { ProjectSelect } from './ProjectSelect';
import { SymlinkDirPicker } from './SymlinkDirPicker';
import { isSupportedDelegationAgent } from '../store/delegation';
import type { AgentDef, GitHubWorkItem, GitIgnoredEntry } from '../ipc/types';
import { DEFAULT_DOCKER_IMAGE, PROJECT_DOCKERFILE_RELATIVE_PATH } from '../lib/docker';
import {
  clampCoordinatorConcurrentTasks,
  DEFAULT_COORDINATOR_CONCURRENT_TASKS,
  MAX_COORDINATOR_CONCURRENT_TASKS,
  MIN_COORDINATOR_CONCURRENT_TASKS,
} from '../lib/coordinator-limits';

/** Follows the user's prompt, so their own description of the work stays first. */
const DELEGATION_REQUEST =
  '\n\nSplit this work into independent parts. Start a Parallel Code task for each, with a ' +
  'prompt that stands on its own. Wait for them to finish, then summarize what each one changed.';
// shortcut: prompt length as a proxy for "several changes" — ask the naming model if it misfires
/** A prompt this long likely describes enough work to be worth splitting. */
const SPLIT_TIP_MIN_PROMPT = 80;
/** The split tip waits for typing to stop this long, so it never interrupts a sentence. */
const SPLIT_TIP_PAUSE_MS = 1500;

interface NewTaskPanelProps {
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

const isClaudeCommand = (command: string) => sessionAgentForCommand(command) === 'claude';

const isInstalledClaude = (agent: AgentDef) =>
  isAgentInstalled(agent) && isClaudeCommand(agent.command);

/**
 * Project of the last teleport, if it still exists. A Claude link doesn't name
 * its repo, so with no remembered project the user picks one rather than
 * teleporting into whatever project happened to be last.
 */
function teleportProjectId(): string | null {
  return codeProjects().some((p) => p.id === store.lastTeleportProjectId)
    ? store.lastTeleportProjectId
    : null;
}

/** `session_011CUabcd…` → "Teleport 011CUabc": short, and the branch is
 *  replaced by the session's own once teleport checks it out. */
function teleportTaskName(sessionId: string): string {
  return `Teleport ${sessionId.replace(/^session_/, '').slice(0, 8)}`;
}

function DockerTaskOptions(props: {
  dockerMode: boolean;
  setDockerMode: (enabled: boolean) => void;
  orchestrationEnabled: boolean;
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
          <Show when={props.orchestrationEnabled && isMac}>
            <InlineBanner color={theme.warning} fontSize="12px">
              Agent orchestration + Docker on macOS: the MCP server binds to all network interfaces
              so sub-task containers can reach it via host.docker.internal. The port is reachable
              from other hosts on your local network (token-protected).
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
                  class="btn-with-icon"
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
                  <ContainerIcon size={12} />
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

function AgentAutomationOptions(props: {
  autoMergeChildren: boolean;
  setAutoMergeChildren: (enabled: boolean) => void;
  autoSendChildUpdates: boolean;
  setAutoSendChildUpdates: (enabled: boolean) => void;
  agentSupportsSkipPermissions: boolean;
  skipPermissions: boolean;
  propagateSkipPermissions: boolean;
  setPropagateSkipPermissions: (enabled: boolean) => void;
  maxConcurrentTasks: number;
  setMaxConcurrentTasks: (value: number) => void;
}) {
  return (
    <div
      data-nav-field="agent-automation"
      style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
    >
      <div style={sectionLabelStyle}>Agent automation</div>
      <CheckboxOption
        label="Automatically merge completed child tasks"
        checked={props.autoMergeChildren}
        onChange={props.setAutoMergeChildren}
      />
      <CheckboxOption
        label="Automatically send child updates"
        checked={props.autoSendChildUpdates}
        onChange={props.setAutoSendChildUpdates}
      />
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
              All child tasks created by this agent will inherit{' '}
              <strong>--dangerously-skip-permissions</strong> and run without confirmation prompts.
            </>
          </InlineBanner>
        </Show>
      </Show>
    </div>
  );
}

export function NewTaskPanel(props: NewTaskPanelProps) {
  const [canvasPrefill, setCanvasPrefill] = createSignal<AppStore['newTaskPrefillPrompt']>(null);
  const [spSource, setSpSource] = createSignal<SpNewTaskSource | null>(null);
  const [kanbanSource, setKanbanSource] = createSignal<KanbanNewTaskSource | null>(null);
  const [ideaId, setIdeaId] = createSignal<string | null>(null);
  const [prompt, setPrompt] = createSignal('');
  const [githubPickerOpen, setGithubPickerOpen] = createSignal(false);
  /** Open PR the task will check out instead of branching from the base branch. */
  const [githubPr, setGithubPr] = createSignal<GitHubWorkItem | null>(null);
  // Prompt/name last generated from a picked GitHub item, so a later pick or a
  // project switch replaces only that text and never what the user typed.
  let picked = { prompt: '', name: '' };
  const [advancedOpen, setAdvancedOpen] = createSignal(false);
  // Prompt/name values right after open/prefill — closing is only guarded when
  // the user has typed something beyond them.
  const [initialPrompt, setInitialPrompt] = createSignal('');
  const [initialName, setInitialName] = createSignal('');
  const [confirmDiscard, setConfirmDiscard] = createSignal(false);
  const [name, setName] = createSignal('');
  const [selectedAgent, setSelectedAgentSignal] = createSignal<AgentDef | null>(null);
  // Empty runs the agent's own default; another agent's model would not apply.
  const [taskModel, setTaskModel] = createSignal({ model: '', effort: '' });
  const modelChoice = createMemo(() => {
    const agent = selectedAgent();
    const provider = agent && modelProvider(agent);
    return agent && provider ? { agent, provider } : undefined;
  });
  const setSelectedAgent = (agent: AgentDef | null) => {
    if (agent?.id !== selectedAgent()?.id) setTaskModel({ model: '', effort: '' });
    setSelectedAgentSignal(agent);
  };
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
  const [autoMergeChildren, setAutoMergeChildren] = createSignal(false);
  const [autoSendChildUpdates, setAutoSendChildUpdates] = createSignal(false);
  const orchestrationEnabled = () => {
    const agent = selectedAgent();
    return (
      store.mcpOrchestrationEnabled &&
      gitIsolation() === 'worktree' &&
      !!agent &&
      isSupportedDelegationAgent(agent)
    );
  };
  const [propagateSkipPermissions, setPropagateSkipPermissions] = createSignal(
    store.defaultPropagateSkipPermissions,
  );
  const [maxConcurrentTasks, setMaxConcurrentTasks] = createSignal(
    DEFAULT_COORDINATOR_CONCURRENT_TASKS,
  );
  const [branchPrefix, setBranchPrefix] = createSignal('');
  let promptRef!: HTMLTextAreaElement;
  let submitRef: HTMLButtonElement | undefined;
  const hasOtherTasks = () => store.taskOrder.length + store.collapsedTaskOrder.length > 0;
  const [promptPaused, setPromptPaused] = createSignal(false);
  let promptPauseTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(promptPauseTimer));
  function handlePromptInput(value: string): void {
    setPrompt(value);
    // Typing on past the split tip counts as having seen it, so it never comes back.
    if (activeFeatureHint() === 'delegate-subtasks') markFeatureHintSeen('delegate-subtasks');
    setPromptPaused(false);
    clearTimeout(promptPauseTimer);
    promptPauseTimer = setTimeout(() => setPromptPaused(true), SPLIT_TIP_PAUSE_MS);
  }
  // Dropped files become paths in the prompt, as on the terminal, so the agent can open
  // them; images from a browser have no path and are saved to a temp file first.
  function handleFileDragOver(e: DragEvent): void {
    if (loading() || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
  function handleFileDrop(e: DragEvent): void {
    const dt = e.dataTransfer;
    if (loading() || !dt?.files.length) return;
    // Stops the textarea's default of inserting only the file name, and the app's
    // GitHub link drop from reading a browser image's URL.
    e.preventDefault();
    e.stopPropagation();
    void insertDroppedPaths(dt);
  }
  async function insertDroppedPaths(dt: DataTransfer): Promise<void> {
    const paths = await dataTransferToShellArgs(dt);
    if (!paths) {
      setError('Could not attach the dropped files.');
      return;
    }
    // Read the caret after resolving: saving a browser image takes a moment to type through.
    const before = prompt().slice(0, promptRef.selectionStart);
    const after = prompt().slice(promptRef.selectionEnd);
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    const trail = after && !/^\s/.test(after) ? ' ' : '';
    handlePromptInput(`${before}${lead}${paths}${trail}${after}`);
    const caret = before.length + lead.length + paths.length;
    promptRef.focus();
    promptRef.setSelectionRange(caret, caret);
  }
  const wantsSplitTip = () =>
    orchestrationEnabled() &&
    hasOtherTasks() &&
    promptPaused() &&
    prompt().trim().length >= SPLIT_TIP_MIN_PROMPT;
  function addDelegationRequest(): void {
    setPrompt(prompt().trimEnd() + DELEGATION_REQUEST);
    promptRef.focus();
    promptRef.setSelectionRange(promptRef.value.length, promptRef.value.length);
  }
  const titleId = createUniqueId();
  const branchInputId = createUniqueId();
  const advancedOptionsId = createUniqueId();
  const promptInputId = createUniqueId();
  const nameInputId = createUniqueId();
  const projectSelectId = createUniqueId();
  const isolationLabelId = createUniqueId();
  let panelRef!: HTMLElement;
  let formRef!: HTMLFormElement;
  let buildOutputRef!: HTMLPreElement;

  const focusableSelector =
    'textarea:not(:disabled), input:not(:disabled), select:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex="-1"])';

  function navigateFormFields(direction: 'up' | 'down'): void {
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

  // Initialize state each time the panel opens.  Wrapped in on() so the
  // effect only re-fires on the props.open *transition*, not whenever any
  // store default mutates while the panel is already open (e.g. the user
  // toggling Settings, or autosave restoring state).  untrack() ensures the
  // store reads inside are one-shot samples, not new reactive subscriptions.
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        untrack(() => {
          setSkipPermissions(store.defaultSkipPermissions);
          setPropagateSkipPermissions(store.defaultPropagateSkipPermissions);
        });
      },
    ),
  );

  // A link dropped while the panel is already open: the open effect below ran
  // before it arrived, and reopening is a no-op. Fill only the text that is
  // still empty so a drop never discards what the user typed. A teleport does
  // replace the project and agent: it only runs in Claude, and a project chosen
  // for an unrelated draft would teleport into the wrong repo.
  createEffect(
    on(
      () => store.newTaskDropUrl,
      (dropUrl) => {
        if (!dropUrl || !untrack(() => props.open)) return;
        untrack(() => {
          const teleportId = parseClaudeSessionUrl(dropUrl);
          const defaults = teleportId ? null : getGitHubDropDefaults(dropUrl);
          if (!teleportId && !prompt().trim()) setPrompt(`review ${dropUrl}`);
          const dropName = teleportId ? teleportTaskName(teleportId) : defaults?.name;
          if (dropName && !name().trim()) setName(dropName);
          if (teleportId) setSelectedProjectId(teleportProjectId());
          else if (defaults?.projectId) setSelectedProjectId(defaults.projectId);
          const claude = teleportId ? store.availableAgents.find(isInstalledClaude) : undefined;
          if (claude) setSelectedAgent(claude);
        });
      },
      { defer: true },
    ),
  );

  // Initialize remaining state each time the panel opens.  Same on()+untrack
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
          // Reset signals for a fresh draft
          setPrompt('');
          setInitialPrompt('');
          setInitialName('');
          setConfirmDiscard(false);
          setCanvasPrefill(null);
          setGithubPickerOpen(false);
          setGithubPr(null);
          picked = { prompt: '', name: '' };
          setAdvancedOpen(false);
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
          setAutoMergeChildren(false);
          setAutoSendChildUpdates(false);
          setMaxConcurrentTasks(DEFAULT_COORDINATOR_CONCURRENT_TASKS);

          let cancelled = false;
          onCleanup(() => {
            cancelled = true;
          });
          void (async () => {
            // Check Docker availability in background
            invoke<boolean>(IPC.CheckDockerAvailable).then(
              (available) => setDockerAvailable(available),
              () => setDockerAvailable(false),
            );
            // Pre-fill from drop data if present
            const dropUrl = store.newTaskDropUrl;
            const targets = codeProjects();
            const fallbackProjectId =
              taskProjectFilter() ??
              targets.find((p) => p.id === store.lastProjectId)?.id ??
              targets[0]?.id ??
              null;
            const teleportId = dropUrl ? parseClaudeSessionUrl(dropUrl) : null;
            const defaults = dropUrl && !teleportId ? getGitHubDropDefaults(dropUrl) : null;

            if (dropUrl && !teleportId) setPrompt(`review ${dropUrl}`);
            if (defaults) setName(defaults.name);
            if (teleportId) setName(teleportTaskName(teleportId));
            setSelectedProjectId(
              teleportId ? teleportProjectId() : (defaults?.projectId ?? fallbackProjectId),
            );

            // Pre-fill from an arena comparison or canvas branch.
            const prefill = store.newTaskPrefillPrompt;
            setSpSource(prefill?.superProductivity ?? null);
            setKanbanSource(prefill?.kanban ?? null);
            setIdeaId(prefill?.ideaId ?? null);
            if (prefill) {
              setPrompt(prefill.prompt);
              setName(prefill.name ?? 'Compare arena results');
              // Holds any prefill: a retried draft also brings its branch and isolation.
              setCanvasPrefill(prefill);
              if (prefill.projectId) setSelectedProjectId(prefill.projectId);
              if (prefill.dockerMode) setDockerMode(true);
              if (prefill.skipPermissions !== undefined)
                setSkipPermissions(prefill.skipPermissions);
            }
            // Snapshot the post-prefill values as the close-guard baseline.
            // A retried draft (only it carries agentId) has no other copy, so
            // closing it must ask first.
            const retried = prefill?.agentId !== undefined;
            setInitialPrompt(retried ? '' : prompt());
            setInitialName(retried ? '' : name());

            // Re-detect while nothing is installed, so a CLI installed after
            // launch shows up on the next open instead of after a restart.
            if (!store.availableAgents.some(isAgentInstalled)) {
              await loadAgents();
            }
            if (cancelled) return;
            setSelectedAgent(
              store.availableAgents.find((a) => a.id === prefill?.agentId) ??
                (teleportId ? store.availableAgents.find(isInstalledClaude) : undefined) ??
                pickDefaultAgent(store.availableAgents, store.lastAgentId),
            );
          })().catch((err) => {
            if (!cancelled) setError(errMessage(err));
          });

          // Capture-phase handler for Alt+Arrow to navigate form sections / within fields
          const handleAltArrow = (e: KeyboardEvent) => {
            if (
              !e.altKey ||
              e.ctrlKey ||
              e.metaKey ||
              e.shiftKey ||
              !panelRef?.contains(e.target as Node) ||
              topDialog()
            )
              return;
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              e.stopImmediatePropagation();
              navigateFormFields(e.key === 'ArrowDown' ? 'down' : 'up');
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
    ),
  );

  // Fetch gitignored dirs whenever the panel opens or the project changes.
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

  // Fetch branches on every panel open and on project change (D-02 merged effect)
  createEffect(() => {
    // D-02, D-03: All reactive reads synchronous before any async code
    const open = props.open;
    const pid = selectedProjectId();
    const canvasDefaults = canvasPrefill();
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
      setBaseBranch(
        (canvasDefaults?.projectId === pid ? canvasDefaults.baseBranch : undefined) ??
          proj?.defaultBaseBranch ??
          mainBranch,
      );
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
        // Inline error + Retry surfaces this in the panel; no toast needed.
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
    // PR checkouts need their own worktree and hide the isolation picker.
    if (hasDirectTask(pid) || githubPr()) {
      setGitIsolation('worktree');
      return;
    }
    const retried = canvasPrefill();
    if (retried?.gitIsolation && retried.projectId === pid) {
      setGitIsolation(retried.gitIsolation);
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

  /** Web session a dropped claude.ai link teleports into this task, if any. */
  const teleportSessionId = () =>
    store.newTaskDropUrl ? parseClaudeSessionUrl(store.newTaskDropUrl) : null;

  /** A same-repo PR is checked out on its own head branch; forks get a prefixed branch. */
  const prUsesHeadBranch = () => !!githubPr() && !githubPr()?.isCrossRepository;

  const branchPreview = () => {
    const prefix = sanitizeBranchPrefix(branchPrefix());
    const pr = githubPr();
    if (pr) return `${prefix}/pr-${pr.number}-…`;
    return `${prefix}/${toBranchName(resolvedName())}`;
  };

  const branchPrefixConflict = createMemo(() => {
    if (gitIsolation() !== 'worktree' || prUsesHeadBranch()) return null;
    return findBranchPrefixConflict(branchPrefix(), branches());
  });

  const branchPrefixError = createMemo(() => {
    const c = branchPrefixConflict();
    return c ? branchPrefixConflictError(c) : '';
  });

  // Validation must stay reachable even when the optional settings are collapsed.
  createEffect(() => {
    if (branchesError() || branchPrefixError()) setAdvancedOpen(true);
  });

  const selectedProjectPath = () => {
    const pid = selectedProjectId();
    return pid ? getProjectPath(pid) : undefined;
  };

  const isNonGitProject = () => {
    const pid = selectedProjectId();
    return pid ? !projectIsGitRepo(pid) : false;
  };

  // Dropped URLs and browser issues already prefill a task; offering the picker too would
  // mix two sources into one prompt.
  const canPickFromGitHub = () =>
    !!selectedProjectPath() &&
    !isNonGitProject() &&
    !canvasPrefill()?.canvasSource &&
    !store.newTaskDropUrl &&
    store.newTaskPrefillPrompt?.githubUrl === undefined;

  /** The prompt without the text generated by the last pick: what the user typed.
   *  Generated text the user edited no longer matches, so it counts as theirs and is kept. */
  const userPromptText = () => {
    const current = prompt();
    return (
      current.startsWith(picked.prompt) ? current.slice(picked.prompt.length) : current
    ).trim();
  };

  /** Puts generated text ahead of the user's own text and returns the new prompt. */
  function applyPickedPrompt(text: string): string {
    const rest = userPromptText();
    const next = rest ? `${text}\n\n${rest}` : text;
    picked.prompt = text;
    setPrompt(next);
    // The split tip waits for a pause after the user's own typing, not after a pick.
    setPromptPaused(false);
    return next;
  }

  function applyPickedName(text: string): void {
    if (!name().trim() || name() === picked.name) setName(text);
    picked.name = text;
  }

  // A picked PR belongs to the project it was listed from; text generated for
  // it would describe another repository's work.
  createEffect(
    on(selectedProjectId, (id) => {
      const prefill = store.newTaskPrefillPrompt;
      setGithubPr(prefill?.projectId === id ? (prefill.githubPr ?? null) : null);
      setGithubPickerOpen(false);
      if (picked.prompt) setPrompt(userPromptText());
      if (picked.name && name() === picked.name) setName('');
      picked = { prompt: '', name: '' };
    }),
  );

  async function pickGitHubItem(item: GitHubWorkItem) {
    const projectRoot = selectedProjectPath();
    if (!projectRoot) return;
    setGithubPickerOpen(false);
    applyPickedName(workItemTaskName(item));
    if (item.kind === 'pr') {
      setGithubPr(item);
      setGitIsolation('worktree');
      applyPickedPrompt(buildPrTaskPrompt(item));
      return;
    }
    setGithubPr(null);
    // Usable right away; the body replaces it once loaded unless the user moved on.
    const withPlaceholder = applyPickedPrompt(buildIssuePrompt({ ...item, body: '' }));
    try {
      const issue = await getGitHubIssue(projectRoot, item.number);
      if (prompt() === withPlaceholder) applyPickedPrompt(buildIssuePrompt(issue));
    } catch (err) {
      // Stay quiet once the user picked something else or edited the prompt.
      if (prompt() === withPlaceholder) {
        setError(`Could not load issue #${item.number}: ${errMessage(err)}`);
      }
    }
  }

  const directDisabled = () => {
    const pid = selectedProjectId();
    return pid ? hasDirectTask(pid) : false;
  };

  const agentSupportsSkipPermissions = () => {
    const agent = selectedAgent();
    // Resolve by command as well as by the def's own args: an agent restored
    // from an older profile still takes the flag, and hiding the checkbox
    // records skipPermissions: false for the life of the task.
    return !!agent && resolveSkipPermissionsArgs(agent).length > 0;
  };

  // Why Create Task is disabled, shown beside it so a greyed-out button is
  // never unexplained. Empty when the form can be submitted.
  const submitBlockedReason = () => {
    // No name/prompt requirement — an empty task defaults to "Task N".
    if (!selectedProjectId()) return 'Select a project';
    // Block submit while branches load — and require a resolved base branch
    // for git projects — so a task can't be created with a stale or empty
    // base branch (e.g. after a failed branch fetch).
    if (branchesLoading()) return 'Loading branches…';
    // Block submit until the symlink candidate list for THIS project has
    // resolved — otherwise stale checkmarks could be submitted against a
    // project whose candidates haven't loaded yet. Direct-mode submits
    // never send symlinkDirs, so a pending probe doesn't block them.
    if (symlinkProbeBlocksSubmit(gitIsolation(), symlinkCandidates.loading())) {
      return 'Checking ignored folders…';
    }
    // A PR task takes its base from the PR, so it does not need the picker's.
    if (!isNonGitProject() && !githubPr()) {
      if (branchesError()) return "Couldn't load branches";
      if (!baseBranch()) return 'Select a base branch';
    }
    if (branchPrefixConflict()) return 'Fix the branch prefix';
    return '';
  };

  const canSubmit = () => !loading() && !submitBlockedReason();

  // Only a direct task waits before the panel closes (it switches branches);
  // a worktree task closes at once, and dimming it would flash in the
  // view transition's captured frame.
  const showBusy = () => loading() && gitIsolation() === 'direct';

  async function handleSubmit(e: Event) {
    e.preventDefault();
    if (!canSubmit()) return;
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

    const p = prompt().trim() || undefined;
    const isFromDrop = !!store.newTaskDropUrl;
    const teleportId = teleportSessionId() ?? undefined;
    if (teleportId && !isClaudeCommand(agent.command)) {
      setError('Teleporting a web session needs Claude Code');
      return;
    }
    const prefix = sanitizeBranchPrefix(branchPrefix());
    const prefixConflict = branchPrefixConflict();
    if (prefixConflict) {
      setError(branchPrefixConflictError(prefixConflict));
      return;
    }
    // A browser prefill decides the link (null = batch, no link); it describes
    // its own project's repository, so another project gets no link.
    const prefill = store.newTaskPrefillPrompt;
    const ghUrl =
      prefill?.githubUrl !== undefined
        ? prefill.projectId === projectId
          ? (prefill.githubUrl ?? undefined)
          : undefined
        : ((p ? extractGitHubUrl(p) : null) ??
          (teleportId ? undefined : (store.newTaskDropUrl ?? undefined)));

    setLoading(true);
    setError('');
    let closing = false;

    try {
      const canvasSource = canvasPrefill()?.canvasSource;
      if (canvasSource) validateCanvasTaskSource(canvasSource, projectId);
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
      const create = canvasSource
        ? (options: Parameters<typeof createTask>[0]) => createCanvasTask(canvasSource, options)
        : createTask;
      const options: CreateTaskOptions = {
        name: n,
        nameIsAutoGenerated: !manualName,
        agentDef: reviewerWithModel(agent, taskModel().model, taskModel().effort),
        projectId,
        gitIsolation: gitIsolation(),
        baseBranch: baseBranch(),
        symlinkDirs: gitIsolation() === 'worktree' ? [...symlinkCandidates.selected()] : undefined,
        branchPrefixOverride: gitIsolation() === 'worktree' ? prefix : undefined,
        initialPrompt: isFromDrop ? undefined : p,
        githubUrl: ghUrl,
        pullRequestNumber: githubPr()?.number,
        teleportSessionId: teleportId,
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
        autoMergeChildren: orchestrationEnabled() ? autoMergeChildren() : undefined,
        autoSendChildUpdates: orchestrationEnabled() ? autoSendChildUpdates() : undefined,
        propagateSkipPermissions:
          orchestrationEnabled() && agentSupportsSkipPermissions() && skipPermissions()
            ? propagateSkipPermissions()
            : undefined,
        maxConcurrentTasks: orchestrationEnabled()
          ? clampCoordinatorConcurrentTasks(maxConcurrentTasks())
          : undefined,
      };
      const source = spSource();
      const card = kanbanSource();
      const idea = ideaId();
      // The panel closes before creation finishes so the next draft can start.
      void createTaskInBackground({
        name: n,
        create: (quick) => create({ ...options, activate: quick }),
        onCreated: (taskId) => {
          // Drop flow: prefill prompt without auto-sending
          if (isFromDrop && p) {
            setPrefillPrompt(taskId, p);
          }
          if (source) linkNewTaskToSp(taskId, source, projectId);
          if (card) void linkNewTaskToKanbanCard(taskId, card, projectId);
          if (idea) removeTaskIdea(idea);
          if (!manualName && p) void nameTaskWithModel(taskId, p);
          // A prefill decided the link itself (null = deliberately none).
          const root = getProjectPath(projectId);
          if (!ghUrl && prefill?.githubUrl === undefined && p && !isFromDrop && root)
            void linkTaskToIssueReference(taskId, root, p);
        },
        draft: {
          prefill: {
            ...prefill,
            // Keep the link decision made for this project: null, not undefined,
            // so a retry doesn't fall back to a URL found in the prompt.
            ...(prefill?.githubUrl !== undefined && { githubUrl: ghUrl ?? null }),
            prompt: prompt(),
            name: manualName,
            projectId,
            agentId: agent.id,
            gitIsolation: gitIsolation(),
            baseBranch: baseBranch() || undefined,
            dockerMode: dockerMode(),
            skipPermissions: skipPermissions(),
            githubPr: githubPr() ?? undefined,
          },
          dropUrl: store.newTaskDropUrl,
        },
      });
      // Loading lasts until the deferred close lands, so a second Enter can't
      // create the task twice.
      closing = true;
      withViewTransition(() => {
        setLoading(false);
        toggleNewTaskPanel(false);
      });
    } catch (err) {
      setError(String(err));
    } finally {
      if (!closing) setLoading(false);
    }
  }

  function isDirty(): boolean {
    return prompt().trim() !== initialPrompt().trim() || name().trim() !== initialName().trim();
  }

  // Preserve typed drafts until the user explicitly discards them.
  function requestClose() {
    if (loading()) return;
    if (isDirty()) {
      setConfirmDiscard(true);
    } else {
      props.onClose();
    }
  }

  // Opening a task from the board closes the panel; this is what it keeps.
  // A creation under way already holds its own draft for a retry.
  function openDraft() {
    if (!props.open || loading() || !isDirty()) return null;
    return {
      prefill: {
        ...store.newTaskPrefillPrompt,
        prompt: prompt(),
        name: name(),
        projectId: selectedProjectId(),
        agentId: selectedAgent()?.id,
        gitIsolation: gitIsolation(),
        baseBranch: baseBranch() || undefined,
        dockerMode: dockerMode(),
        skipPermissions: skipPermissions(),
        githubPr: githubPr() ?? undefined,
      },
      dropUrl: store.newTaskDropUrl,
    };
  }

  createFocusRestore(() => props.open);
  onMount(() => {
    promptRef?.focus();
    registerFocusFn('new-task', () => promptRef?.focus());
    onCleanup(() => unregisterFocusFn('new-task'));
    onCleanup(registerOpenDraft(openDraft));
  });
  createEffect(() => {
    if (!props.open) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || topDialog() || !panelRef?.contains(e.target as Node)) return;
      e.stopImmediatePropagation();
      requestClose();
    };
    document.addEventListener('keydown', handleEscape);
    onCleanup(() => document.removeEventListener('keydown', handleEscape));
  });

  return (
    <section
      ref={panelRef}
      aria-labelledby={titleId}
      data-new-task-panel
      class="new-task-appearing"
      onDragOver={handleFileDragOver}
      onDrop={handleFileDrop}
      onFocusIn={() => setStore('newTaskPanelFocused', true)}
      onFocusOut={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setStore('newTaskPanelFocused', false);
        }
      }}
      style={{
        position: 'relative',
        height: '100%',
        display: 'flex',
        'flex-direction': 'column',
        background: theme.islandBg,
        border: `1px solid ${theme.border}`,
        'border-radius': 'var(--radius-lg)',
        overflow: 'hidden',
        'box-sizing': 'border-box',
      }}
    >
      <form
        ref={formRef}
        class="new-task-panel-form"
        onSubmit={handleSubmit}
        inert={loading()}
        aria-busy={loading()}
        style={{
          opacity: showBusy() ? '0.4' : '1',
          display: 'flex',
          'flex-direction': 'column',
          'min-height': '0',
          flex: '1',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            'overflow-y': 'auto',
            'min-height': '0',
            flex: '1 1 auto',
            display: 'flex',
            'flex-direction': 'column',
            gap: '20px',
            padding: '20px',
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

          {/* Prompt input (optional) */}
          <div
            data-nav-field="prompt"
            style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
          >
            <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
              <label for={promptInputId} style={sectionLabelStyle}>
                Prompt <span style={{ opacity: '0.5', 'text-transform': 'none' }}>(optional)</span>
              </label>
              <Show when={canPickFromGitHub()}>
                <button
                  type="button"
                  class="btn-secondary btn-with-icon"
                  aria-expanded={githubPickerOpen()}
                  onClick={() => setGithubPickerOpen((v) => !v)}
                  title="Start from an open GitHub issue or pull request (uses the gh CLI)"
                  style={{
                    'margin-left': 'auto',
                    'flex-shrink': '0',
                    'white-space': 'nowrap',
                    padding: '4px 12px',
                    background: 'transparent',
                    border: `1px solid ${theme.border}`,
                    'border-radius': 'var(--radius-sm)',
                    color: theme.fgMuted,
                    'font-size': '12px',
                    cursor: 'pointer',
                  }}
                >
                  <GitHubIcon size={12} />
                  From GitHub…
                </button>
              </Show>
            </div>
            <Show when={githubPickerOpen() && selectedProjectPath()}>
              {(root) => <GitHubItemPicker projectRoot={root()} onPick={pickGitHubItem} />}
            </Show>
            <Show when={githubPr()}>
              {(pr) => (
                <InlineBanner color={theme.accent}>
                  <span style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                    <span style={{ flex: '1' }}>
                      Checks out PR #{pr().number}
                      {pr().baseRefName ? ` (base ${pr().baseRefName})` : ''}.
                      <Show when={pr().baseRefName && !branches().includes(pr().baseRefName ?? '')}>
                        {' '}
                        {pr().baseRefName} is not a local branch, so the diff{' '}
                        {baseBranch() ? `compares against ${baseBranch()}` : 'has no base branch'}.
                      </Show>
                      <Show when={pr().isCrossRepository}>
                        {' '}
                        The PR comes from a fork: the task gets its own branch, and pushing does not
                        update the PR.
                      </Show>
                    </span>
                    <button
                      type="button"
                      class="btn-secondary"
                      onClick={() => setGithubPr(null)}
                      style={{
                        padding: '2px 8px',
                        background: 'transparent',
                        border: `1px solid ${theme.border}`,
                        'border-radius': 'var(--radius-sm)',
                        color: theme.fgMuted,
                        'font-size': '12px',
                        cursor: 'pointer',
                      }}
                    >
                      Don't check out
                    </button>
                  </span>
                </InlineBanner>
              )}
            </Show>
            <Show when={teleportSessionId()}>
              {(id) => (
                <InlineBanner color={theme.accent}>
                  <span style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                    <span style={{ flex: '1' }}>
                      Teleports Claude web session {id()}: Claude Code continues it here and checks
                      out its branch.
                    </span>
                    <button
                      type="button"
                      class="btn-secondary"
                      onClick={() => {
                        // The generated name describes the teleport; one the user typed stays.
                        if (name() === teleportTaskName(id())) setName('');
                        setStore('newTaskDropUrl', null);
                      }}
                      style={{
                        padding: '2px 8px',
                        background: 'transparent',
                        border: `1px solid ${theme.border}`,
                        'border-radius': 'var(--radius-sm)',
                        color: theme.fgMuted,
                        'font-size': '12px',
                        cursor: 'pointer',
                      }}
                    >
                      Don't teleport
                    </button>
                  </span>
                </InlineBanner>
              )}
            </Show>
            <textarea
              ref={promptRef}
              id={promptInputId}
              class="input-field"
              value={prompt()}
              onInput={(e) => handlePromptInput(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  e.stopPropagation();
                  if (canSubmit()) handleSubmit(e);
                }
              }}
              placeholder="What should the agent work on? Drop files or images to add their paths."
              rows={6}
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
            {/* Points at Create Task, the decision it informs, so the card sits
            over the footer instead of the fields still being filled in. */}
            <FeatureHint
              id="delegate-subtasks"
              when={wantsSplitTip()}
              anchor={() => submitRef}
              title="Big change? Let the agent split it"
              actions={[{ label: 'Add split request', run: addDelegationRequest }]}
            >
              {selectedAgent()?.name ?? 'The agent'} can run each part as its own task in its own
              worktree and keep track of them.
              <Show when={!autoMergeChildren()}> You review each result before it merges.</Show>
            </FeatureHint>
          </div>

          {/* Project selector */}
          <div
            data-nav-field="project"
            style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
          >
            <label for={projectSelectId} style={sectionLabelStyle}>
              Project
            </label>
            <Show
              when={!canvasPrefill()?.canvasSource}
              fallback={<span>{getProject(selectedProjectId() ?? '')?.name}</span>}
            >
              <ProjectSelect
                id={projectSelectId}
                value={selectedProjectId()}
                onChange={setSelectedProjectId}
              />
            </Show>
          </div>

          <AgentSelector
            agents={store.availableAgents}
            selectedAgent={selectedAgent()}
            onSelect={setSelectedAgent}
            action={
              <Show when={modelChoice()}>
                {(choice) => (
                  <NewTaskModelPicker
                    agent={choice().agent}
                    provider={choice().provider}
                    model={taskModel().model}
                    effort={taskModel().effort}
                    onChange={(model, effort) => setTaskModel({ model, effort })}
                  />
                )}
              </Show>
            }
          />
          <Show when={selectedAgent()?.available === false ? selectedAgent() : undefined}>
            {(agent) => (
              <InlineBanner color={theme.warning}>
                <Show
                  when={store.availableAgents.some(isAgentInstalled)}
                  fallback={
                    <>
                      No coding agent CLI found on this machine. Install one, such as Claude Code (
                      <code>claude</code>), Codex CLI (<code>codex</code>) or Antigravity CLI (
                      <code>agy</code>), then reopen this panel.
                    </>
                  }
                >
                  {agent().name} was not found on this machine (<code>{agent().command}</code>).
                  Unless it runs in a Docker image, pick an installed agent.
                </Show>
              </InlineBanner>
            )}
          </Show>

          <div
            data-nav-field="advanced-options"
            style={{ 'border-top': `1px solid ${theme.border}`, 'padding-top': '16px' }}
          >
            <button
              type="button"
              aria-expanded={advancedOpen()}
              aria-controls={advancedOptionsId}
              onClick={() => setAdvancedOpen((open) => !open)}
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '8px',
                width: '100%',
                padding: '4px 0',
                background: 'transparent',
                border: 'none',
                color: theme.fgMuted,
                'font-size': '13px',
                'text-align': 'left',
                cursor: 'pointer',
              }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
                style={{ transform: advancedOpen() ? 'rotate(90deg)' : undefined }}
              >
                <path d="m6 3 5 5-5 5" stroke="currentColor" stroke-width="1.5" />
              </svg>
              Advanced options
            </button>
          </div>
          <Show when={advancedOpen()}>
            <div
              id={advancedOptionsId}
              style={{ display: 'flex', 'flex-direction': 'column', gap: '20px' }}
            >
              <div
                data-nav-field="task-name"
                style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
              >
                <label for={nameInputId} style={sectionLabelStyle}>
                  Task name{' '}
                  <span style={{ opacity: '0.5', 'text-transform': 'none' }}>
                    (optional — derived from prompt)
                  </span>
                </label>
                <input
                  id={nameInputId}
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
                <Show
                  when={gitIsolation() === 'direct' && !isNonGitProject() && selectedProjectPath()}
                >
                  <div
                    data-direct-target
                    style={{
                      'font-size': '12px',
                      'font-family': 'var(--font-mono)',
                      color: theme.fgSubtle,
                      display: 'flex',
                      'flex-direction': 'column',
                      gap: '2px',
                      padding: '4px 2px 0',
                    }}
                  >
                    <span style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
                      <GitBranchIcon size={11} style={{ 'flex-shrink': '0' }} />
                      {/* Submit checks out this branch before the agent starts. */}
                      {baseBranch() ||
                        (branchesLoading() ? 'Loading branches…' : 'No branch selected')}
                    </span>
                    <span style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
                      <FolderIcon size={11} style={{ 'flex-shrink': '0' }} />
                      {selectedProjectPath()}
                    </span>
                  </div>
                </Show>
              </div>

              <Show when={gitIsolation() === 'worktree' && !prUsesHeadBranch()}>
                <BranchPrefixField
                  branchPrefix={branchPrefix()}
                  branchPreview={branchPreview()}
                  error={branchPrefixError()}
                  projectPath={selectedProjectPath()}
                  onPrefixChange={setBranchPrefix}
                />
              </Show>

              {/* Isolation mode selector — hidden for non-git projects and PR checkouts */}
              <Show when={!isNonGitProject() && !githubPr()}>
                <div
                  data-nav-field="git-isolation"
                  style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
                >
                  <span id={isolationLabelId} style={sectionLabelStyle}>
                    Git Isolation
                  </span>
                  <SegmentedButtons
                    labelledBy={isolationLabelId}
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
                </div>
              </Show>

              {/* Branch picker — hidden for non-git projects and PR checkouts */}
              <Show when={!isNonGitProject() && !githubPr()}>
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
                          class="btn-with-icon"
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
                          <SyncIcon size={12} />
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
                      <Show when={!dockerMode() && store.dockerAvailable}>
                        <div style={{ 'font-size': '12px', color: theme.fgMuted }}>
                          Tip: Enable Docker isolation to limit the blast radius of skip-permissions
                          mode.
                        </div>
                      </Show>
                      <Show when={!store.dockerAvailable}>
                        <div style={{ 'font-size': '12px', color: theme.fgMuted }}>
                          Install Docker to enable container isolation for safer skip-permissions
                          mode.
                        </div>
                      </Show>
                    </Show>
                  </div>
                </Show>

                <DockerTaskOptions
                  dockerMode={dockerMode()}
                  setDockerMode={setDockerMode}
                  orchestrationEnabled={orchestrationEnabled()}
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

              <Show when={orchestrationEnabled()}>
                <AgentAutomationOptions
                  autoMergeChildren={autoMergeChildren()}
                  setAutoMergeChildren={setAutoMergeChildren}
                  autoSendChildUpdates={autoSendChildUpdates()}
                  setAutoSendChildUpdates={setAutoSendChildUpdates}
                  agentSupportsSkipPermissions={agentSupportsSkipPermissions()}
                  skipPermissions={skipPermissions()}
                  propagateSkipPermissions={propagateSkipPermissions()}
                  setPropagateSkipPermissions={setPropagateSkipPermissions}
                  maxConcurrentTasks={maxConcurrentTasks()}
                  setMaxConcurrentTasks={setMaxConcurrentTasks}
                />
              </Show>

              <Show when={symlinkCandidates.dirs().length > 0 && gitIsolation() === 'worktree'}>
                <SymlinkDirPicker
                  dirs={symlinkCandidates.dirs()}
                  selectedDirs={symlinkCandidates.selected()}
                  onToggle={symlinkCandidates.toggle}
                />
              </Show>
            </div>
          </Show>

          {/* Below the options that cause them, so a warning appearing never
          pushes the clicked control out from under the pointer. */}
          <Show when={gitIsolation() === 'direct' && !isNonGitProject()}>
            <InlineBanner color={theme.warning}>
              Changes will be made on the selected branch without worktree isolation.
            </InlineBanner>
          </Show>
          <Show when={agentSupportsSkipPermissions() && skipPermissions()}>
            <InlineBanner color={theme.warning}>
              The agent will run without asking for confirmation. It can read, write, and delete
              files, and execute commands without your approval.
            </InlineBanner>
          </Show>

          <Show when={error()}>
            <div
              role="alert"
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
            padding: '16px 20px',
            'border-top': `1px solid ${theme.border}`,
            background: theme.islandBg,
            'flex-shrink': '0',
          }}
        >
          {/* Space stays reserved so the reason coming and going never moves the buttons. */}
          <span
            data-submit-reason
            aria-live="polite"
            style={{
              'margin-right': 'auto',
              'align-self': 'center',
              'min-width': '0',
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
              'white-space': 'nowrap',
              'font-size': '12px',
              color: theme.fgSubtle,
              visibility: submitBlockedReason() && !loading() ? 'visible' : 'hidden',
            }}
          >
            {submitBlockedReason()}
          </span>
          <button
            type="button"
            class="btn-secondary"
            disabled={loading()}
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
            ref={submitRef}
            type="submit"
            class="btn-primary"
            disabled={!canSubmit()}
            aria-keyshortcuts={isMac ? 'Meta+Enter' : 'Control+Enter'}
            style={{
              padding: '9px 20px',
              'border-radius': 'var(--radius-md)',
              cursor: 'pointer',
              'font-size': '14px',
              'font-weight': '500',
              opacity: !canSubmit() ? '0.4' : '1',
              'white-space': 'nowrap',
              'flex-shrink': '0',
              display: 'inline-flex',
              'align-items': 'center',
              gap: '8px',
            }}
          >
            <PlusIcon size={14} />
            Create Task
            <kbd
              class="new-task-submit-kbd"
              aria-hidden="true"
              style={{ font: 'inherit', 'font-size': '11px', color: theme.fgSubtle }}
            >
              {isMac ? '⌘↵' : 'Ctrl+Enter'}
            </kbd>
          </button>
        </div>
      </form>
      <Show when={showBusy()}>
        <div
          role="status"
          style={{
            position: 'absolute',
            inset: '0',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            color: theme.fg,
            'font-size': '14px',
            cursor: 'wait',
          }}
        >
          <span
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '8px',
              padding: '12px 16px',
              background: theme.islandBg,
              'border-radius': 'var(--radius-md)',
            }}
          >
            <span class="inline-spinner" aria-hidden="true" />
            Creating task…
          </span>
        </div>
      </Show>
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
    </section>
  );
}
