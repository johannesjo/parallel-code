import { createSignal, createEffect, onMount, onCleanup } from 'solid-js';
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
} from '../store/store';
import { useFocusRegistration } from '../lib/focus-registration';
import { ResizablePanel, type PanelChild } from './ResizablePanel';
import type { EditableTextHandle } from './EditableText';
import { PromptInput, type PromptInputHandle } from './PromptInput';
import { ScalablePanel } from './ScalablePanel';
import { CloseTaskDialog } from './CloseTaskDialog';
import { MergeDialog } from './MergeDialog';
import { PushDialog } from './PushDialog';
import { DiffViewerDialog } from './DiffViewerDialog';
import { PlanViewerDialog } from './PlanViewerDialog';
import { EditProjectDialog } from './EditProjectDialog';
import { TaskTitleBar } from './TaskTitleBar';
import { TaskBranchInfoBar } from './TaskBranchInfoBar';
import { TaskNotesPanel } from './TaskNotesPanel';
import { TaskShellSection } from './TaskShellSection';
import { TaskAITerminal } from './TaskAITerminal';
import { TaskClosingOverlay } from './TaskClosingOverlay';
import { theme } from '../lib/theme';
import type { Task } from '../store/types';

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
  const [editingProjectId, setEditingProjectId] = createSignal<string | null>(null);
  let panelRef!: HTMLDivElement;
  let promptRef: HTMLTextAreaElement | undefined;
  let titleEditHandle: EditableTextHandle | undefined;
  let promptHandle: PromptInputHandle | undefined;

  const editingProject = () => {
    const id = editingProjectId();
    return id ? (getProject(id) ?? null) : null;
  };

  // Focus registration for this task's panels
  onMount(() => {
    const id = props.task.id;
    useFocusRegistration(`${id}:title`, () => titleEditHandle?.startEdit());
    useFocusRegistration(`${id}:prompt`, () => promptRef?.focus());
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

  const firstAgentId = () => props.task.agentIds[0] ?? '';

  function titleBar(): PanelChild {
    return {
      id: 'title',
      initialSize: 50,
      fixed: true,
      content: () => (
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
      ),
    };
  }

  function branchInfoBar(): PanelChild {
    return {
      id: 'branch',
      initialSize: 28,
      fixed: true,
      content: () => (
        <TaskBranchInfoBar task={props.task} onEditProject={(id) => setEditingProjectId(id)} />
      ),
    };
  }

  function notesAndFiles(): PanelChild {
    return {
      id: 'notes-files',
      initialSize: 150,
      minSize: 60,
      content: () => (
        <TaskNotesPanel
          task={props.task}
          isActive={props.isActive}
          onPlanFullscreen={() => setPlanFullscreen(true)}
          onDiffFileClick={(path) => setDiffScrollTarget(path)}
        />
      ),
    };
  }

  function shellSection(): PanelChild {
    return {
      id: 'shell-section',
      initialSize: 28,
      minSize: 28,
      get fixed() {
        return props.task.shellAgentIds.length === 0;
      },
      requestSize: () => (props.task.shellAgentIds.length > 0 ? 200 : 28),
      content: () => <TaskShellSection task={props.task} isActive={props.isActive} />,
    };
  }

  function aiTerminal(): PanelChild {
    return {
      id: 'ai-terminal',
      minSize: 80,
      content: () => (
        <TaskAITerminal task={props.task} isActive={props.isActive} promptHandle={promptHandle} />
      ),
    };
  }

  function promptInput(): PanelChild {
    return {
      id: 'prompt',
      initialSize: 72,
      stable: true,
      minSize: 54,
      maxSize: 300,
      content: () => (
        <ScalablePanel panelId={`${props.task.id}:prompt`}>
          <div
            onClick={() => setTaskFocusedPanel(props.task.id, 'prompt')}
            style={{ height: '100%' }}
          >
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
        </ScalablePanel>
      ),
    };
  }

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
      <ResizablePanel
        direction="vertical"
        persistKey={`task:${props.task.id}`}
        children={[
          titleBar(),
          branchInfoBar(),
          notesAndFiles(),
          shellSection(),
          aiTerminal(),
          ...(store.showPromptInput ? [promptInput()] : []),
        ]}
      />
      <CloseTaskDialog
        open={showCloseConfirm()}
        task={props.task}
        onDone={() => setShowCloseConfirm(false)}
      />
      <MergeDialog
        open={showMergeConfirm()}
        task={props.task}
        initialCleanup={getProject(props.task.projectId)?.deleteBranchOnClose ?? true}
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
      />
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
