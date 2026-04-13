import { Show, createSignal, createEffect, onMount, onCleanup, batch } from 'solid-js';
import {
  store,
  retryCloseTask,
  setActiveTask,
  clearInitialPrompt,
  clearPrefillPrompt,
  getProject,
  setTaskFocusedPanel,
  triggerFocus,
  clearPendingAction,
  showNotification,
  setTaskSplitMode,
} from '../store/store';
import { useFocusRegistration } from '../lib/focus-registration';
import { ResizablePanel, type PanelChild } from './ResizablePanel';
import type { EditableTextHandle } from './EditableText';
import { PromptInput, type PromptInputHandle } from './PromptInput';
import { CloseTaskDialog } from './CloseTaskDialog';
import { MergeDialog } from './MergeDialog';
import { PushDialog } from './PushDialog';
import { DiffViewerDialog } from './DiffViewerDialog';
import { PlanViewerDialog } from './PlanViewerDialog';
import { EditProjectDialog } from './EditProjectDialog';
import { TaskTitleBar } from './TaskTitleBar';
import { TaskBranchInfoBar } from './TaskBranchInfoBar';
import { TaskNotesBody } from './TaskNotesBody';
import { TaskChangedFilesSection } from './TaskChangedFilesSection';
import { TaskShellSection } from './TaskShellSection';
import { TaskStepsSection } from './TaskStepsSection';
import { TaskAITerminal } from './TaskAITerminal';
import { TaskClosingOverlay } from './TaskClosingOverlay';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { theme } from '../lib/theme';
import type { Task } from '../store/types';
import type { CommitInfo } from '../ipc/types';

interface TaskPanelProps {
  task: Task;
  isActive: boolean;
}

export function TaskPanel(props: TaskPanelProps) {
  const [showCloseConfirm, setShowCloseConfirm] = createSignal(false);
  const [planFullscreen, setPlanFullscreen] = createSignal(false);

  const [showMergeConfirm, setShowMergeConfirm] = createSignal(false);
  const [showPushConfirm, setShowPushConfirm] = createSignal(false);
  const [pushSuccess, setPushSuccess] = createSignal(false);
  const [pushing, setPushing] = createSignal(false);
  let pushSuccessTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(pushSuccessTimer));
  const [diffScrollTarget, setDiffScrollTarget] = createSignal<string | null>(null);
  const [commitList, setCommitList] = createSignal<CommitInfo[]>([]);
  const [selectedCommit, setSelectedCommit] = createSignal<string | null>(null);
  const [editingProjectId, setEditingProjectId] = createSignal<string | null>(null);
  const [stepsNaturalHeight, setStepsNaturalHeight] = createSignal(110);
  // Jump-to-step state is a single signal so ↗ can be hidden entirely before
  // TerminalView is ready (otherwise firstIndex would default to 0, showing ↗
  // on every step while `jump` is still undefined and every click no-ops).
  const [stepNav, setStepNav] = createSignal<
    { jump: (stepIndex: number) => boolean; firstIndex: number } | undefined
  >();
  let panelRef!: HTMLDivElement;
  let promptRef: HTMLTextAreaElement | undefined;
  let titleEditHandle: EditableTextHandle | undefined;
  let promptHandle: PromptInputHandle | undefined;

  // Two-column focus-mode layout kicks in once the task panel is wide enough.
  // Hysteresis: enter at >=1200, leave at <1150. A single threshold flickers
  // when the user drags the window edge across it, and every flip remounts the
  // xterm terminal inside the left column.
  const SPLIT_ENTER_WIDTH = 1200;
  const SPLIT_EXIT_WIDTH = 1150;
  const [panelWidth, setPanelWidth] = createSignal(0);
  const [useSplit, setUseSplit] = createSignal(false);
  createEffect(() => {
    if (!store.focusMode) {
      setUseSplit(false);
      return;
    }
    const w = panelWidth();
    setUseSplit((prev) => (prev ? w >= SPLIT_EXIT_WIDTH : w >= SPLIT_ENTER_WIDTH));
  });

  // Mirror split state into the store so keyboard navigation (focus.ts)
  // can build the correct grid for this task.
  createEffect(() => {
    setTaskSplitMode(props.task.id, useSplit());
  });
  onCleanup(() => setTaskSplitMode(props.task.id, false));

  const editingProject = () => {
    const id = editingProjectId();
    return id ? (getProject(id) ?? null) : null;
  };

  // Focus registration for this task's panels
  onMount(() => {
    const id = props.task.id;
    useFocusRegistration(`${id}:title`, () => titleEditHandle?.startEdit());
    useFocusRegistration(`${id}:prompt`, () => promptRef?.focus());

    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setPanelWidth(w);
    });
    ro.observe(panelRef);
    setPanelWidth(panelRef.clientWidth);
    onCleanup(() => ro.disconnect());
  });

  // Respond to focus panel changes from store
  createEffect(() => {
    if (!props.isActive) return;
    const panel = store.focusedPanel[props.task.id];
    if (panel) {
      triggerFocus(`${props.task.id}:${panel}`);
    }
  });

  // Auto-focus prompt when task first becomes active
  let autoFocusTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    if (autoFocusTimer !== undefined) clearTimeout(autoFocusTimer);
  });
  createEffect(() => {
    if (props.isActive && !store.focusedPanel[props.task.id]) {
      const id = props.task.id;
      if (autoFocusTimer !== undefined) clearTimeout(autoFocusTimer);
      autoFocusTimer = setTimeout(() => {
        autoFocusTimer = undefined;
        if (!store.focusedPanel[id] && !panelRef.contains(document.activeElement)) {
          if (store.showPromptInput) {
            promptRef?.focus();
          } else {
            setTaskFocusedPanel(id, 'ai-terminal');
            triggerFocus(`${id}:ai-terminal`);
          }
        }
      }, 0);
    }
  });

  // React to pendingAction from keyboard shortcuts
  createEffect(() => {
    const action = store.pendingAction;
    if (!action || action.taskId !== props.task.id) return;
    clearPendingAction();
    switch (action.type) {
      case 'close':
        setShowCloseConfirm(true);
        break;
      case 'merge':
        if (props.task.gitIsolation === 'worktree') setShowMergeConfirm(true);
        break;
      case 'push':
        if (props.task.gitIsolation === 'worktree') setShowPushConfirm(true);
        break;
    }
  });

  // Poll for branch commits for all worktree-isolated tasks (not just the active one),
  // so CommitNavBar shows correct state regardless of which column is focused.
  createEffect(() => {
    const worktreePath = props.task.worktreePath;
    const baseBranch = props.task.baseBranch;
    if (props.task.gitIsolation !== 'worktree') return;
    let cancelled = false;

    async function fetchCommits() {
      try {
        const result = await invoke<CommitInfo[]>(IPC.GetBranchCommits, {
          worktreePath,
          baseBranch,
        });
        if (cancelled) return;
        batch(() => {
          setCommitList(result);
          // Reset selection if the selected commit no longer exists
          const sel = selectedCommit();
          if (sel !== null && !result.some((c) => c.hash === sel)) {
            setSelectedCommit(null);
          }
        });
      } catch {
        /* worktree may not exist yet */
      }
    }

    void fetchCommits();
    const timer = setInterval(() => void fetchCommits(), 5000);
    onCleanup(() => {
      cancelled = true;
      clearInterval(timer);
    });
  });

  const firstAgentId = () => props.task.agentIds[0] ?? '';

  // Heavy components are created once and reused in both stack and split
  // layouts. Solid owns their reactive scope under TaskPanel (not under the
  // <Show> branch), so when the user crosses the split threshold the DOM is
  // reparented instead of destroyed+recreated. That avoids the expensive
  // xterm.js teardown/reinit and scrollback replay on every layout flip.
  const aiTerminalEl = (
    <TaskAITerminal
      task={props.task}
      isActive={props.isActive}
      promptHandle={promptHandle}
      onStepJumpReady={(fn, fromIdx) => {
        setStepNav(fn ? { jump: fn, firstIndex: fromIdx } : undefined);
      }}
    />
  );
  const shellSectionEl = <TaskShellSection task={props.task} isActive={props.isActive} />;
  const notesBodyEl = (
    <TaskNotesBody
      task={props.task}
      agentId={firstAgentId()}
      onPlanFullscreen={() => setPlanFullscreen(true)}
    />
  );
  const changedFilesEl = (
    <TaskChangedFilesSection
      task={props.task}
      isActive={props.isActive}
      commitList={commitList()}
      selectedCommit={selectedCommit()}
      onCommitNavigate={setSelectedCommit}
      onDiffFileClick={(path) => setDiffScrollTarget(path)}
    />
  );
  const stepsSectionEl = (
    <TaskStepsSection
      task={props.task}
      isActive={props.isActive}
      onFileClick={(file) => setDiffScrollTarget(file)}
      onNaturalHeight={setStepsNaturalHeight}
      firstJumpableIndex={stepNav()?.firstIndex}
      onJumpToStep={
        stepNav()
          ? (idx) => {
              const ok = stepNav()?.jump(idx) ?? false;
              if (ok) setTaskFocusedPanel(props.task.id, 'ai-terminal');
              return ok;
            }
          : undefined
      }
    />
  );
  const promptInputEl = (
    <div onClick={() => setTaskFocusedPanel(props.task.id, 'prompt')} style={{ height: '100%' }}>
      <PromptInput
        taskId={props.task.id}
        agentId={firstAgentId()}
        initialPrompt={props.task.initialPrompt}
        prefillPrompt={props.task.prefillPrompt}
        onSend={() => {
          if (props.task.initialPrompt) clearInitialPrompt(props.task.id);
        }}
        onPrefillConsumed={() => clearPrefillPrompt(props.task.id)}
        ref={(el) => (promptRef = el)}
        handle={(h) => (promptHandle = h)}
      />
    </div>
  );

  // PanelChild wrappers — stable references so ResizablePanel's <For> reuses
  // entries (and therefore the DOM inside them) across re-evaluations.

  const stepsSectionChild: PanelChild = {
    id: 'steps-section',
    initialSize: 28,
    minSize: 28,
    get fixed() {
      return !props.task.stepsContent?.length;
    },
    requestSize: stepsNaturalHeight,
    content: () => stepsSectionEl,
  };

  const shellSectionChild: PanelChild = {
    id: 'shell-section',
    initialSize: 28,
    minSize: 28,
    get fixed() {
      return props.task.shellAgentIds.length === 0;
    },
    requestSize: () => (props.task.shellAgentIds.length > 0 ? 200 : 28),
    content: () => shellSectionEl,
  };

  const aiTerminalChild: PanelChild = {
    id: 'ai-terminal',
    minSize: 80,
    content: () => aiTerminalEl,
  };

  const promptInputChild: PanelChild = {
    id: 'prompt',
    initialSize: 72,
    stable: true,
    minSize: 54,
    maxSize: 300,
    content: () => promptInputEl,
  };

  // Stack-mode inner horizontal split: notes on the left, changed-files on the right.
  // Non-git tasks only get the notes panel (no changed-files split).
  const isNoneGit = () => props.task.gitIsolation === 'none';
  const stackNotesSplitChildren = (): PanelChild[] =>
    isNoneGit()
      ? [{ id: 'notes', initialSize: 200, minSize: 100, content: () => notesBodyEl }]
      : [
          { id: 'notes', initialSize: 200, minSize: 100, content: () => notesBodyEl },
          { id: 'changed-files', initialSize: 200, minSize: 100, content: () => changedFilesEl },
        ];
  const notesAndFilesChild: PanelChild = {
    id: 'notes-files',
    initialSize: 150,
    minSize: 60,
    content: () =>
      isNoneGit() ? (
        notesBodyEl
      ) : (
        <ResizablePanel
          direction="horizontal"
          persistKey={`task:${props.task.id}:notes-split`}
          children={stackNotesSplitChildren()}
        />
      ),
  };

  // Split-mode right-column children.
  const splitChangedFilesChild: PanelChild = {
    id: 'changed-files',
    initialSize: 200,
    minSize: 80,
    content: () => changedFilesEl,
  };
  const splitNotesBodyChild: PanelChild = {
    id: 'notes-body',
    initialSize: 200,
    minSize: 80,
    content: () => notesBodyEl,
  };

  return (
    <div
      ref={panelRef}
      class={`task-column ${props.isActive ? 'active' : ''}`}
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100%',
        background: theme.taskContainerBg,
        'border-radius': '12px',
        border: `1px solid ${theme.border}`,
        overflow: 'clip',
        position: 'relative',
      }}
      onClick={() => setActiveTask(props.task.id)}
    >
      <TaskClosingOverlay
        closingStatus={props.task.closingStatus}
        closingError={props.task.closingError}
        onRetry={() => retryCloseTask(props.task.id)}
      />
      {/* Title + branch bars live outside <Show> so they don't remount on layout flips. */}
      <div style={{ flex: '0 0 50px', overflow: 'hidden' }}>
        <TaskTitleBar
          task={props.task}
          isActive={props.isActive}
          onClose={() => setShowCloseConfirm(true)}
          onMerge={() => setShowMergeConfirm(true)}
          onPush={() => setShowPushConfirm(true)}
          pushing={pushing()}
          pushSuccess={pushSuccess()}
          onTitleEditRef={(h) => (titleEditHandle = h)}
        />
      </div>
      <div style={{ flex: '0 0 28px', overflow: 'hidden' }}>
        <TaskBranchInfoBar task={props.task} onEditProject={(id) => setEditingProjectId(id)} />
      </div>
      <div style={{ flex: '1', 'min-height': '0' }}>
        <Show
          when={useSplit()}
          fallback={
            <ResizablePanel
              direction="vertical"
              persistKey={`task:${props.task.id}`}
              children={[
                notesAndFilesChild,
                shellSectionChild,
                aiTerminalChild,
                ...(props.task.stepsEnabled ? [stepsSectionChild] : []),
                ...(store.showPromptInput ? [promptInputChild] : []),
              ]}
            />
          }
        >
          <ResizablePanel
            direction="horizontal"
            persistKey={`task:${props.task.id}:split-cols`}
            children={[
              {
                id: 'left-col',
                initialSize: 800,
                minSize: 420,
                content: () => (
                  <ResizablePanel
                    direction="vertical"
                    persistKey={`task:${props.task.id}:split-left`}
                    children={[
                      aiTerminalChild,
                      ...(store.showPromptInput ? [promptInputChild] : []),
                    ]}
                  />
                ),
              },
              {
                id: 'right-col',
                initialSize: 400,
                minSize: 280,
                content: () => (
                  <ResizablePanel
                    direction="vertical"
                    persistKey={`task:${props.task.id}:split-right`}
                    children={[
                      ...(isNoneGit() ? [] : [splitChangedFilesChild]),
                      splitNotesBodyChild,
                      ...(props.task.stepsEnabled ? [stepsSectionChild] : []),
                      shellSectionChild,
                    ]}
                  />
                ),
              },
            ]}
          />
        </Show>
      </div>
      <CloseTaskDialog
        open={showCloseConfirm()}
        task={props.task}
        onDone={() => setShowCloseConfirm(false)}
      />
      <Show when={props.task.gitIsolation !== 'none'}>
        <MergeDialog
          open={showMergeConfirm()}
          task={props.task}
          initialCleanup={
            props.task.externalWorktree
              ? false
              : (getProject(props.task.projectId)?.deleteBranchOnClose ?? true)
          }
          onDone={() => setShowMergeConfirm(false)}
          onDiffFileClick={(file) => setDiffScrollTarget(file.path)}
        />
        <PushDialog
          open={showPushConfirm()}
          task={props.task}
          onStart={() => {
            setPushing(true);
            setPushSuccess(false);
            clearTimeout(pushSuccessTimer);
          }}
          onClose={() => {
            setShowPushConfirm(false);
          }}
          onDone={(success) => {
            const wasHidden = !showPushConfirm();
            setShowPushConfirm(false);
            setPushing(false);
            if (success) {
              setPushSuccess(true);
              pushSuccessTimer = setTimeout(() => setPushSuccess(false), 3000);
            }
            if (wasHidden) {
              showNotification(success ? 'Push completed' : 'Push failed');
            }
          }}
        />
        <DiffViewerDialog
          scrollToFile={diffScrollTarget()}
          worktreePath={props.task.worktreePath}
          projectRoot={getProject(props.task.projectId)?.path}
          branchName={props.task.branchName}
          baseBranch={props.task.baseBranch}
          onClose={() => setDiffScrollTarget(null)}
          taskId={props.task.id}
          agentId={props.task.agentIds[0]}
          commitList={commitList()}
          selectedCommit={selectedCommit()}
          onCommitNavigate={setSelectedCommit}
          gitIsolation={props.task.gitIsolation}
        />
      </Show>
      <EditProjectDialog project={editingProject()} onClose={() => setEditingProjectId(null)} />
      <PlanViewerDialog
        open={planFullscreen()}
        onClose={() => setPlanFullscreen(false)}
        planContent={props.task.planContent ?? ''}
        planFileName={props.task.planFileName ?? 'plan.md'}
        taskId={props.task.id}
        agentId={props.task.agentIds[0]}
        worktreePath={props.task.worktreePath}
      />
    </div>
  );
}
