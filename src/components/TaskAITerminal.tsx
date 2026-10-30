import { Show, For, createSignal, createEffect, onMount, onCleanup, untrack } from 'solid-js';
import type { TranscriptMarks } from '../investigation/transcript';

import {
  store,
  markAgentExited,
  restartAgent,
  switchAgent,
  setLastPrompt,
  markAgentOutput,
  registerFocusFn,
  unregisterFocusFn,
  setTaskFocusedPanel,
  aiTerminalPanelId,
  isPanelFocused,
  isPanelFocusedOrDefault,
  setActiveAgent,
  setActiveTask,
  addAgentToTask,
  closeAgentInTask,
  showNotification,
  retryTeleportInRepo,
  toggleAITerminalLayout,
} from '../store/store';
import { markDirty } from '../lib/terminalFitManager';
import { isAgentAskingQuestion, isAgentSettled } from '../store/taskStatus';
import { warn as logWarn } from '../lib/log';
import { AgentHandoffComposer } from './AgentHandoffComposer';
import { isSupportedDelegationAgent } from '../store/delegation';
import { InfoBar } from './InfoBar';
import { PromptHistory } from './PromptHistory';
import { TerminalView } from './TerminalView';
import { fileLinkMenu, type ChangesLink, type FileLinkMenu } from './file-link-menu';
import { findBareFile } from '../lib/find-bare-file';
import { parseTeleportRepoMismatch } from '../lib/claude-session-url';
import { createMarkdownViewer } from './MarkdownViewerDialog';
import { SessionPicker } from './SessionPicker';
import { createResumeWithFlags } from './resume-with-flags';
import { AgentChatView } from './AgentChatView';
import { isAgentChat, agentChatProvider, agentChatUnavailableReason } from '../store/agent-chat';
import { agentViewHandsOff, agentViewSwitchCost, switchMainAgentView } from '../store/agent-view';
import { setStore } from '../store/core';
import { editAsDocument } from '../documents/store';
import { saveState } from '../store/persistence';
import { registerAction, unregisterAction } from '../store/focus';
import { ConfirmDialog } from './ConfirmDialog';
import { CloseIcon, CommentIcon, PlayIcon, SyncIcon, TerminalIcon } from './icons';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { getTaskDockerOverlayLabel } from '../lib/docker';
import { codexResumeId } from '../../electron/shared/codex-resume';
import type { Task } from '../store/types';
import type { AgentDef } from '../ipc/types';
import type { PromptInputHandle } from './PromptInput';
import { buildTaskAgentArgs, isResumeArgsFailure } from '../lib/agent-args';

interface TaskAITerminalProps {
  task: Task;
  isActive: boolean;
  /** The entire terminal section can be hidden by its parent view. */
  visible?: boolean;
  selectedAgentId: string;
  onSelectAgent?: (agentId: string) => void;
  promptHandle: PromptInputHandle | undefined;
  /** Each agent terminal's raw marker API, so other panels can anchor their own keys. */
  onTranscriptMarksReady?: (agentId: string, api: TranscriptMarks | undefined) => void;
  /** First look at a Markdown path the agent printed; returns true when it
   *  took the link. Otherwise the file opens in the Markdown viewer. */
  onFileLink?: (filePath: string) => boolean;
  /** Present where the task has a side panel: opens a worktree-relative Markdown path there. */
  onOpenInSidePanel?: (relativePath: string) => void;
  /** The task's changed files, which links open in the changes dialog. */
  changes?: ChangesLink;
  onReview?: (path?: string) => void;
  /** Opens the tour the agent published through `tour_publish`. */
  onOpenTour?: () => void;
}

export function TaskAITerminal(props: TaskAITerminalProps) {
  const [handoff, setHandoff] = createSignal<{
    sourceAgentId: string;
    selection?: string;
    recipientAgentId?: string;
  }>();
  const handoffAgents = () =>
    props.task.agentIds.filter((id) => {
      const agent = store.agents[id];
      return (
        agent &&
        agent.status !== 'exited' &&
        agent.sessionInstanceId &&
        !isAgentChat(props.task, id) &&
        isSupportedDelegationAgent(agent.def)
      );
    });
  const canHandoff = (id: string) => store.mcpOrchestrationEnabled && handoffAgents().includes(id);
  createEffect(() => {
    const key = `${props.task.id}:second-opinion`;
    const open = () => {
      if (
        props.isActive &&
        props.visible !== false &&
        !handoff() &&
        canHandoff(props.selectedAgentId)
      ) {
        setHandoff({ sourceAgentId: props.selectedAgentId });
      }
    };
    registerAction(key, open);
    onCleanup(() => unregisterAction(key, open));
  });
  const markdownViewer = createMarkdownViewer();
  /** Markdown the caller doesn't take opens in the dialog. */
  const routeMarkdown = (filePath: string) => {
    if (!props.onFileLink?.(filePath)) markdownViewer.show(filePath);
  };

  const firstAgentId = () => props.task.agentIds[0] ?? '';
  const [switchingView, setSwitchingView] = createSignal(false);
  const [viewError, setViewError] = createSignal('');
  const [noticeRequested, setNoticeRequested] = createSignal(false);
  /** The view the user asked for and has yet to confirm quitting the other for. */
  const [pendingSwitch, setPendingSwitch] = createSignal<'chat' | 'terminal' | null>(null);
  const currentView = () => (isAgentChat(props.task, firstAgentId()) ? 'chat' : 'terminal');
  const agentName = () => (agentChatProvider(firstAgentId()) === 'claude' ? 'Claude' : 'Codex');
  /** Whether leaving the terminal hands its conversation over, rather than
   *  leaving a running CLI behind and opening a separate chat. */
  const terminalHandoff = () => agentViewHandsOff(props.task, firstAgentId(), 'chat');
  const switchBlockedReason = () => {
    const unavailable = agentChatUnavailableReason(props.task);
    if (unavailable) return unavailable;
    if (currentView() === 'chat') {
      const state = store.agents[firstAgentId()]?.chatState;
      if (state?.requests.length) return 'Resolve the pending request before switching views';
      if (state?.status === 'working' || state?.status === 'starting')
        return 'Finish or stop the response before switching views';
    } else if (terminalHandoff()) {
      if (props.task.initialPrompt) return 'Wait for the queued prompt before switching views';
      if (props.task.terminalInputPending)
        return 'Send or clear the terminal draft before switching views';
      if (!isAgentSettled(firstAgentId()))
        return `Wait for ${agentName()} to finish and resolve pending requests before switching views`;
    }
    return '';
  };
  // A handoff failure stands until the next attempt, but a precondition is
  // transient: report whichever one holds *now*, so the alert can neither keep
  // asking for something already done nor resurface a reason that has since
  // been replaced by a different one.
  const viewNotice = () => viewError() || (noticeRequested() ? switchBlockedReason() : '');
  // Drop a question whose cost has gone, so a later restart cannot make the
  // dialog reappear for a switch the user asked about minutes ago.
  createEffect(() => {
    const mode = pendingSwitch();
    if (mode && !agentViewSwitchCost(props.task, firstAgentId(), mode)) setPendingSwitch(null);
  });
  async function switchView(mode: 'chat' | 'terminal', confirmed = false) {
    // The answer is spent whatever happens below — including a refusal, which
    // belongs in the alert rather than behind a dialog that stays open.
    if (confirmed) setPendingSwitch(null);
    if (currentView() === mode || switchingView()) return;
    // A disabled button's tooltip is unreachable by keyboard and screen readers,
    // so the precondition is reported where the handoff errors already appear.
    const blocked = switchBlockedReason();
    setNoticeRequested(!!blocked);
    setViewError('');
    if (blocked) return;
    // Quitting a live CLI is the user's call, and the answer is asked for again
    // on every switch: what the running side is in the middle of changes.
    if (!confirmed && agentViewSwitchCost(props.task, firstAgentId(), mode)) {
      setPendingSwitch(mode);
      return;
    }
    const agentId = firstAgentId();
    const taskId = props.task.id;
    setSwitchingView(true);
    try {
      await switchMainAgentView(taskId, agentId, mode);
      if (!store.tasks[taskId] || !store.agents[agentId]) return;
      selectAgent(agentId);
      void saveState();
    } catch (error) {
      setViewError(error instanceof Error ? error.message : String(error));
    } finally {
      setSwitchingView(false);
    }
  }
  const selectedAgent = () =>
    store.agents[props.selectedAgentId] ?? store.agents[firstAgentId()] ?? undefined;

  const multipleAgents = () => props.task.agentIds.length > 1;
  const tabsMode = () => multipleAgents() && props.task.aiTerminalLayout === 'tabs';
  const visibleAgentId = () =>
    props.task.agentIds.includes(props.selectedAgentId)
      ? props.selectedAgentId
      : (props.task.agentIds[0] ?? '');

  // In tabs mode only the selected pane is shown; the others stay mounted but
  // hidden (visibility:hidden) so their pty sessions and scrollback survive the
  // switch. As a pane becomes the visible tab, re-fit it (its container may
  // have resized while hidden). The repaint / WebGL reattach on that edge is
  // TerminalView's job, driven by the `visible` prop passed below.
  createEffect(() => {
    if (props.visible === false) return;
    if (tabsMode()) {
      const id = visibleAgentId();
      if (id) markDirty(id);
    } else if (props.visible === true) {
      for (const id of props.task.agentIds) markDirty(id);
    }
  });

  const infoBarStatus = () => {
    if (selectedAgent()?.status === 'exited' && props.task.initialPrompt) {
      return {
        title: 'Agent exited before prompt was sent',
        text: 'Agent exited before prompt was sent',
      };
    }

    // Common on a fresh session: a trust or permission prompt comes up before
    // the first instruction can go in, and "waiting" would look stuck.
    if (props.task.initialPrompt && isAgentAskingQuestion(props.task.agentIds[0] ?? '')) {
      return {
        title: 'Answer the agent to send the queued prompt',
        text: 'Answer the agent to send the queued prompt',
      };
    }

    if (props.task.dockerMode && props.task.initialPrompt) {
      return {
        title: 'Starting Docker container…',
        text: 'Starting Docker container…',
      };
    }

    return props.task.initialPrompt
      ? { title: 'Waiting to send prompt…', text: 'Waiting to send prompt…' }
      : { title: 'No prompts sent yet', text: 'No prompts sent' };
  };

  function selectAgent(agentId: string) {
    setActiveTask(props.task.id);
    props.onSelectAgent?.(agentId);
    setActiveAgent(agentId);
    setTaskFocusedPanel(props.task.id, aiTerminalPanelId(agentId));
  }

  async function closeAgent(agentId: string) {
    const ids = props.task.agentIds;
    const idx = ids.indexOf(agentId);
    const nextAgentId = ids[idx + 1] ?? ids[idx - 1];
    const wasSelected = props.selectedAgentId === agentId;
    await closeAgentInTask(props.task.id, agentId);
    if (wasSelected && nextAgentId) {
      setActiveTask(props.task.id);
      props.onSelectAgent?.(nextAgentId);
      setActiveAgent(nextAgentId);
      setTaskFocusedPanel(props.task.id, aiTerminalPanelId(nextAgentId));
    }
  }

  function registerAgentFocus(agentId: string, focusFn: () => void) {
    registerFocusFn(`${props.task.id}:${aiTerminalPanelId(agentId)}`, focusFn);
  }

  function unregisterAgentFocus(agentId: string) {
    unregisterFocusFn(`${props.task.id}:${aiTerminalPanelId(agentId)}`);
  }

  return (
    <>
      <div
        class="shell-terminal-container"
        style={{
          height: '100%',
          position: 'relative',
          background: theme.taskPanelBg,
          display: 'flex',
          'flex-direction': 'column',
        }}
        onPointerDown={() =>
          setTaskFocusedPanel(props.task.id, aiTerminalPanelId(props.selectedAgentId))
        }
      >
        <InfoBar
          allowOverflow
          onDblClick={() => {
            const prompt = props.task.lastPrompt;
            if (!prompt) return;
            navigator.clipboard
              .writeText(prompt)
              .then(() => showNotification('Prompt copied to clipboard'))
              .catch((err: unknown) => logWarn('clipboard', 'writeText failed', { err }));
          }}
        >
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '8px',
              width: '100%',
              'min-width': '0',
            }}
          >
            <PromptHistory task={props.task} emptyLabel={infoBarStatus().text} />
            <div class="agent-header-controls">
              <div class="agent-header-tabs">
                <For each={props.task.agentIds}>
                  {(agentId, i) => {
                    const agent = () => store.agents[agentId];
                    const selected = () => props.selectedAgentId === agentId;
                    return (
                      <span
                        style={{
                          display: 'inline-flex',
                          'align-items': 'center',
                          height: '20px',
                        }}
                      >
                        <button
                          type="button"
                          title={agent()?.def.description ?? agent()?.def.name}
                          aria-pressed={selected()}
                          onClick={(e) => {
                            e.stopPropagation();
                            selectAgent(agentId);
                          }}
                          style={{
                            display: 'inline-flex',
                            'align-items': 'center',
                            gap: '4px',
                            height: '20px',
                            padding: '0 7px',
                            background: selected() ? theme.bgSelected : theme.bgInput,
                            border: selected()
                              ? `1px solid ${theme.accent}`
                              : `1px solid ${theme.border}`,
                            'border-right':
                              props.task.agentIds.length > 1
                                ? 'none'
                                : selected()
                                  ? `1px solid ${theme.accent}`
                                  : `1px solid ${theme.border}`,
                            color: selected() ? theme.fg : theme.fgMuted,
                            'border-radius': props.task.agentIds.length > 1 ? '5px 0 0 5px' : '5px',
                            cursor: 'pointer',
                            'font-size': sf(11),
                            'font-family': "'JetBrains Mono', monospace",
                          }}
                        >
                          <span>{agent()?.def.name ?? `Agent ${i() + 1}`}</span>
                          <Show when={props.task.agentIds.length > 1}>
                            <span style={{ opacity: 0.55 }}>#{i() + 1}</span>
                          </Show>
                        </button>
                        <Show when={props.task.agentIds.length > 1}>
                          <button
                            type="button"
                            title="Close AI agent"
                            onClick={(e) => {
                              e.stopPropagation();
                              void closeAgent(agentId);
                            }}
                            style={{
                              display: 'inline-flex',
                              'align-items': 'center',
                              'justify-content': 'center',
                              width: '20px',
                              height: '20px',
                              background: selected() ? theme.bgSelected : theme.bgInput,
                              border: selected()
                                ? `1px solid ${theme.accent}`
                                : `1px solid ${theme.border}`,
                              color: theme.fgMuted,
                              'border-radius': '0 5px 5px 0',
                              cursor: 'pointer',
                              padding: '0',
                            }}
                          >
                            <CloseIcon size={11} />
                          </button>
                        </Show>
                      </span>
                    );
                  }}
                </For>
              </div>
              <Show when={multipleAgents()}>
                <button
                  type="button"
                  title={
                    tabsMode() ? 'Show agents side by side' : 'Show one agent at a time (tabs)'
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleAITerminalLayout(props.task.id);
                  }}
                  style={{
                    display: 'inline-flex',
                    'align-items': 'center',
                    'justify-content': 'center',
                    width: '22px',
                    height: '20px',
                    background: theme.bgInput,
                    border: `1px solid ${theme.border}`,
                    color: theme.fgMuted,
                    'border-radius': 'var(--radius-sm)',
                    cursor: 'pointer',
                    padding: '0',
                  }}
                >
                  <Show
                    when={tabsMode()}
                    fallback={
                      /* Currently side-by-side → click switches to tabs (one panel). */
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.3"
                      >
                        <rect x="2" y="2.75" width="12" height="10.5" rx="1.25" />
                        <path d="M2 5.75 H14" />
                      </svg>
                    }
                  >
                    {/* Currently tabbed → click switches to side-by-side columns. */}
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.3"
                    >
                      <rect x="2" y="2.75" width="5" height="10.5" rx="1.25" />
                      <rect x="9" y="2.75" width="5" height="10.5" rx="1.25" />
                    </svg>
                  </Show>
                </button>
              </Show>
              <AddAgentMenu taskId={props.task.id} />
              <Show when={agentChatProvider(firstAgentId())}>
                <div
                  class="agent-view-switch"
                  role="group"
                  aria-label="Main agent view"
                  aria-busy={switchingView()}
                >
                  <For each={['chat', 'terminal'] as const}>
                    {(mode) => {
                      const selected = () => currentView() === mode;
                      const blocked = () => !selected() && !!switchBlockedReason();
                      return (
                        <button
                          type="button"
                          aria-label={`Show main agent ${mode}`}
                          aria-pressed={selected()}
                          // Never `disabled`: it would move focus to <body> mid
                          // handoff, and `switchView` already guards re-entry.
                          aria-disabled={blocked() || switchingView()}
                          title={
                            // Without this the button announces itself disabled
                            // mid-handoff while promising that it works.
                            switchingView()
                              ? 'Switching conversation…'
                              : blocked()
                                ? switchBlockedReason()
                                : mode === 'chat'
                                  ? terminalHandoff()
                                    ? 'Continue this conversation in Chat'
                                    : `Open a separate ${agentName()} chat in this worktree`
                                  : 'Open the terminal conversation'
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            void switchView(mode);
                          }}
                        >
                          {mode === 'chat' ? <CommentIcon size={12} /> : <TerminalIcon size={12} />}
                        </button>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </div>
          </div>
        </InfoBar>
        <Show when={handoff()} keyed>
          {(request) => (
            <AgentHandoffComposer
              task={props.task}
              sourceAgentId={request.sourceAgentId}
              selection={request.selection}
              recipientAgentId={request.recipientAgentId}
              onClose={(recipientAgentId) => {
                setHandoff(undefined);
                if (recipientAgentId) selectAgent(recipientAgentId);
              }}
            />
          )}
        </Show>
        <Show when={viewNotice()}>
          <div class="agent-view-error" role="alert">
            {viewNotice()}
          </div>
        </Show>
        <div
          class="agent-terminal-row"
          classList={{ 'agent-terminal-row-tabs': tabsMode() }}
          style={{
            flex: '1',
            display: 'flex',
            // Tabs mode stacks panes absolutely; a positioning context is needed.
            position: tabsMode() ? 'relative' : 'static',
            overflow: 'hidden',
            background: multipleAgents() ? theme.taskContainerBg : 'transparent',
          }}
        >
          <For each={props.task.agentIds}>
            {(agentId) => (
              <AgentTerminalPane
                task={props.task}
                agentId={agentId}
                canClose={multipleAgents()}
                tabsMode={tabsMode()}
                visible={props.visible !== false && (!tabsMode() || visibleAgentId() === agentId)}
                onSelect={() => selectAgent(agentId)}
                fileLinkMenu={(filePath, line) =>
                  fileLinkMenu(filePath, line, {
                    worktreePath: props.task.worktreePath,
                    openDialog: markdownViewer.show,
                    openMarkdown: props.onFileLink ? routeMarkdown : undefined,
                    openInSidePanel: props.onOpenInSidePanel,
                    changes: props.changes,
                  })
                }
                findBareFile={(name) => findBareFile(name, props.task)}
                onEditAsDocument={store.documentWorkspacesEnabled ? editAsDocument : undefined}
                onReview={props.onReview}
                onOpenTour={props.onOpenTour}
                onSendSelection={
                  canHandoff(agentId) && !handoff()
                    ? (selection, recipientAgentId) =>
                        setHandoff({ sourceAgentId: agentId, selection, recipientAgentId })
                    : undefined
                }
                onSecondOpinion={
                  canHandoff(agentId) && !handoff()
                    ? () => setHandoff({ sourceAgentId: agentId })
                    : undefined
                }
                handoffRecipients={handoffAgents()
                  .filter((id) => id !== agentId)
                  .map((id) => ({
                    id,
                    label: `${store.agents[id].def.name} · ${props.task.agentIds.indexOf(id) + 1}`,
                  }))}
                onReady={registerAgentFocus}
                onUnmount={unregisterAgentFocus}
                onTranscriptMarksReady={(api) => props.onTranscriptMarksReady?.(agentId, api)}
              />
            )}
          </For>
        </div>
      </div>
      {markdownViewer.view()}
      <Show when={pendingSwitch()}>
        {(mode) => (
          // Re-read on every render: the CLI on the other side may have exited
          // on its own while the dialog was open, and then there is nothing
          // left to quit — the question goes away with the cost.
          <Show when={agentViewSwitchCost(props.task, firstAgentId(), mode())}>
            {(cost) => (
              <ConfirmDialog
                open
                title={cost().title}
                message={cost().message}
                confirmLabel={cost().confirmLabel}
                onConfirm={() => void switchView(mode(), true)}
                onCancel={() => setPendingSwitch(null)}
              />
            )}
          </Show>
        )}
      </Show>
    </>
  );
}

function AddAgentMenu(props: { taskId: string }) {
  const [open, setOpen] = createSignal(false);
  const [addingAgentId, setAddingAgentId] = createSignal<string | null>(null);
  let menuRef: HTMLSpanElement | undefined;

  const availableAgents = () => store.availableAgents.filter((agent) => agent.available !== false);

  const handleClickOutside = (e: MouseEvent) => {
    if (menuRef && !menuRef.contains(e.target as Node)) setOpen(false);
  };

  onMount(() => document.addEventListener('mousedown', handleClickOutside));
  onCleanup(() => document.removeEventListener('mousedown', handleClickOutside));

  async function addAgent(agentDef: AgentDef) {
    if (addingAgentId()) return;
    setAddingAgentId(agentDef.id);
    try {
      const agentId = await addAgentToTask(props.taskId, agentDef);
      if (agentId) {
        setActiveTask(props.taskId);
        setActiveAgent(agentId);
        setTaskFocusedPanel(props.taskId, aiTerminalPanelId(agentId));
      }
      setOpen(false);
    } catch (err) {
      console.error('Failed to add agent:', err);
    } finally {
      setAddingAgentId(null);
    }
  }

  return (
    <span style={{ position: 'relative', display: 'inline-flex' }} ref={(el) => (menuRef = el)}>
      <button
        type="button"
        title="Add AI agent"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open());
        }}
        style={{
          display: 'inline-flex',
          'align-items': 'center',
          'justify-content': 'center',
          width: '22px',
          height: '20px',
          background: theme.bgInput,
          border: `1px solid ${theme.border}`,
          color: theme.fgMuted,
          'border-radius': 'var(--radius-sm)',
          cursor: 'pointer',
          padding: '0',
        }}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 2.75a.75.75 0 0 1 .75.75v3.75h3.75a.75.75 0 0 1 0 1.5H8.75v3.75a.75.75 0 0 1-1.5 0V8.75H3.5a.75.75 0 0 1 0-1.5h3.75V3.5A.75.75 0 0 1 8 2.75Z" />
        </svg>
      </button>
      <Show when={open()}>
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: '0',
            'margin-top': '4px',
            background: theme.bgElevated,
            border: `1px solid ${theme.border}`,
            'border-radius': 'var(--radius-sm)',
            padding: '4px 0',
            'z-index': '30',
            'min-width': '180px',
            'box-shadow': '0 4px 12px rgba(0,0,0,0.3)',
          }}
        >
          <div style={{ padding: '4px 10px', 'font-size': sf(11), color: theme.fgMuted }}>
            Add agent
          </div>
          <For each={availableAgents()}>
            {(agentDef) => (
              <button
                type="button"
                title={agentDef.description}
                disabled={addingAgentId() !== null}
                onClick={(e) => {
                  e.stopPropagation();
                  void addAgent(agentDef);
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  background: addingAgentId() === agentDef.id ? theme.bgSelected : 'transparent',
                  border: 'none',
                  color: theme.fg,
                  padding: '5px 10px',
                  cursor: addingAgentId() === null ? 'pointer' : 'default',
                  'font-size': sf(11),
                  'text-align': 'left',
                }}
                onMouseEnter={(e) => {
                  if (addingAgentId() === null) e.currentTarget.style.background = theme.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background =
                    addingAgentId() === agentDef.id ? theme.bgSelected : 'transparent';
                }}
              >
                {agentDef.name}
              </button>
            )}
          </For>
        </div>
      </Show>
    </span>
  );
}

function AgentTerminalPane(props: {
  onSendSelection?: (text: string, recipientAgentId?: string) => void;
  onSecondOpinion?: () => void;
  handoffRecipients: { id: string; label: string }[];
  task: Task;
  onReview?: (path?: string) => void;
  onOpenTour?: () => void;
  agentId: string;
  canClose: boolean;
  /** When true the pane is one of several stacked tabs (only `visible` shown). */
  tabsMode: boolean;
  visible: boolean;
  onSelect: () => void;
  fileLinkMenu: (filePath: string, line: number | undefined) => FileLinkMenu;
  findBareFile: (name: string) => Promise<string | undefined>;
  onEditAsDocument?: (filePath: string) => void;
  onReady: (agentId: string, focusFn: () => void) => void;
  onUnmount: (agentId: string) => void;
  onTranscriptMarksReady?: (api: TranscriptMarks | undefined) => void;
}) {
  onCleanup(() => props.onUnmount(props.agentId));

  const dockerOverlayLabel = () => getTaskDockerOverlayLabel(props.task.dockerSource);
  const agent = () => store.agents[props.agentId];
  const resumeWithFlags = createResumeWithFlags(() => props.agentId);
  const [terminalOpened, setTerminalOpened] = createSignal(
    untrack(() => !isAgentChat(props.task, props.agentId)),
  );
  let terminalFocus: (() => void) | undefined;
  let chatFocus: (() => void) | undefined;
  const focusCurrentView = () => {
    if (isAgentChat(props.task, props.agentId)) chatFocus?.();
    else terminalFocus?.();
  };
  createEffect(() => {
    if (!isAgentChat(props.task, props.agentId)) setTerminalOpened(true);
  });

  return (
    <div
      class="focusable-panel shell-terminal-container agent-terminal-pane"
      data-panel-focused={
        isPanelFocused(props.task.id, aiTerminalPanelId(props.agentId)) ? 'true' : 'false'
      }
      style={{
        ...(props.tabsMode
          ? {
              position: 'absolute',
              inset: '0',
              visibility: props.visible ? 'visible' : 'hidden',
              // Pauses xterm rendering for hidden tabs; see TilingLayout.
              'content-visibility': props.visible ? 'visible' : 'hidden',
              'pointer-events': props.visible ? 'auto' : 'none',
            }
          : {
              flex: '1',
              'min-width': props.canClose ? '260px' : '0',
              position: 'relative',
            }),
        overflow: 'hidden',
        display: 'flex',
        'flex-direction': 'column',
        background: theme.taskPanelBg,
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        props.onSelect();
      }}
    >
      <Show when={props.task.dockerMode}>
        <div
          style={{
            position: 'absolute',
            top: '8px',
            left: '12px',
            'z-index': '10',
            display: 'flex',
            'align-items': 'center',
            gap: '6px',
            'font-size': sf(11),
            color: theme.fgMuted,
            background: 'color-mix(in srgb, var(--island-bg) 80%, transparent)',
            padding: '2px 8px',
            'border-radius': 'var(--radius-sm)',
            border: `1px solid ${theme.border}`,
          }}
        >
          <span title={props.task.dockerImage}>{dockerOverlayLabel()}</span>
        </div>
      </Show>
      <resumeWithFlags.Dialog />
      <Show when={agent()}>
        {(a) => (
          <>
            <Show when={a().status === 'exited' && !isAgentChat(props.task, props.agentId)}>
              <div
                class="exit-badge"
                title={a().lastOutput.length ? a().lastOutput.join('\n') : undefined}
                style={{
                  position: 'absolute',
                  top: '8px',
                  right: '12px',
                  'z-index': '10',
                  'font-size': sf(12),
                  color: a().exitCode === 0 ? theme.success : theme.error,
                  background: 'color-mix(in srgb, var(--island-bg) 80%, transparent)',
                  padding: '4px 12px',
                  'border-radius': 'var(--radius-md)',
                  border: `1px solid ${theme.border}`,
                  display: 'flex',
                  'align-items': 'center',
                  gap: '8px',
                }}
              >
                <span>
                  {a().signal === 'spawn_failed'
                    ? 'Failed to start'
                    : `Process exited (${a().exitCode ?? '?'})`}
                </span>
                <AgentRestartMenu agentId={a().id} agentDefId={a().def.id} />
                <Show when={a().def.resume_args?.length}>
                  <button
                    class="btn-with-icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      restartAgent(a().id, true);
                    }}
                    style={{
                      background: theme.bgElevated,
                      border: `1px solid ${theme.border}`,
                      color: theme.fg,
                      padding: '2px 8px',
                      'border-radius': 'var(--radius-xs)',
                      cursor: 'pointer',
                      'font-size': sf(11),
                    }}
                  >
                    <PlayIcon size={12} />
                    Resume
                  </button>
                </Show>
                <SessionPicker
                  taskId={props.task.id}
                  agentId={a().id}
                  command={a().def.command}
                  currentSessionId={props.task.agentSessionIds?.[a().id]}
                />
              </div>
            </Show>
            <Show when={isAgentChat(props.task, props.agentId)}>
              <AgentChatView
                onReview={props.onReview}
                onOpenTour={props.onOpenTour}
                task={props.task}
                agentId={props.agentId}
                active={
                  props.visible &&
                  (isPanelFocusedOrDefault(props.task.id, aiTerminalPanelId(props.agentId)) ||
                    // Chat mode hides the prompt panel, so its focus key lands in this composer.
                    isPanelFocused(props.task.id, 'prompt'))
                }
                onReady={(focus) => {
                  chatFocus = focus;
                  props.onReady(props.agentId, focusCurrentView);
                }}
              />
            </Show>
            <Show when={terminalOpened()}>
              <div
                style={{ display: isAgentChat(props.task, props.agentId) ? 'none' : 'contents' }}
              >
                <Show when={`${a().id}:${a().generation}`} keyed>
                  <TerminalView
                    taskId={props.task.id}
                    onSendSelection={props.onSendSelection}
                    onSecondOpinion={props.onSecondOpinion}
                    handoffRecipients={props.handoffRecipients}
                    agentId={a().id}
                    visible={props.visible && !isAgentChat(props.task, props.agentId)}
                    isFocused={
                      !isAgentChat(props.task, props.agentId) &&
                      isPanelFocused(props.task.id, aiTerminalPanelId(props.agentId))
                    }
                    command={a().def.command}
                    args={buildTaskAgentArgs(
                      a().def,
                      props.task,
                      a().resumed,
                      a().id,
                      props.task.agentSessionIds?.[a().id],
                    )}
                    cwd={props.task.worktreePath}
                    envFile={store.agentEnvFiles[a().def.id]}
                    dockerMode={
                      props.task.dockerMode ||
                      Boolean(
                        props.task.coordinatedBy &&
                        store.tasks[props.task.coordinatedBy]?.dockerMode,
                      )
                    }
                    dockerImage={
                      props.task.dockerMode
                        ? props.task.dockerImage
                        : props.task.coordinatedBy
                          ? store.tasks[props.task.coordinatedBy]?.dockerImage
                          : undefined
                    }
                    dockerMountWorktreeParent={
                      (props.task.coordinatorMode && props.task.dockerMode) ||
                      Boolean(
                        props.task.coordinatedBy &&
                        store.tasks[props.task.coordinatedBy]?.dockerMode,
                      )
                    }
                    attachExisting={a().attachExisting}
                    preserveSessionOnCleanup
                    onExit={(code) => {
                      if (
                        !a().requireResumeSuccess &&
                        a().resumed &&
                        code.exit_code !== 0 &&
                        isResumeArgsFailure(a().def.command, code.last_output)
                      ) {
                        // Resume args failed (e.g. Claude's "No conversation to continue");
                        // fall back to a fresh start with normal args.
                        restartAgent(a().id, false);
                        return;
                      }
                      if (
                        props.task.mainAgentView !== 'chat' &&
                        props.task.agentIds[0] === a().id &&
                        a().def.id === 'codex' &&
                        props.task.codexChatHandoff
                      ) {
                        const threadId =
                          code.exit_code === 0 && (!code.signal || code.signal === '0')
                            ? codexResumeId(code.last_output.join('\n'))
                            : undefined;
                        // /new and /model in the CLI may change the session or its settings.
                        // Keep only its confirmed final ID; let Codex restore the native settings.
                        setStore(
                          'tasks',
                          props.task.id,
                          'codexChatHandoff',
                          threadId
                            ? { threadId, model: undefined, reasoningEffort: undefined }
                            : undefined,
                        );
                        void saveState();
                      }
                      if (
                        a().requireResumeSuccess &&
                        code.exit_code !== 0 &&
                        isResumeArgsFailure(a().def.command, code.last_output)
                      )
                        showNotification(
                          'Resume failed. Your existing conversation was not replaced; review the terminal error before retrying.',
                        );
                      const teleportId = props.task.teleportSessionId;
                      const teleportRepo =
                        teleportId && props.task.agentIds[0] === a().id && !a().resumed
                          ? parseTeleportRepoMismatch(code.last_output)
                          : null;
                      if (teleportId && teleportRepo) {
                        // Claude links don't name their repo, so the first try can
                        // land in the wrong project; the CLI's refusal names it.
                        retryTeleportInRepo(teleportId, teleportRepo);
                        showNotification(
                          `This web session belongs to ${teleportRepo}. Choose its project to teleport it.`,
                        );
                      }
                      markAgentExited(a().id, code);
                    }}
                    onData={(data) => markAgentOutput(a().id, data, props.task.id)}
                    fileLinkMenu={props.fileLinkMenu}
                    findBareFile={props.findBareFile}
                    onEditAsDocument={props.onEditAsDocument}
                    paneActions={[
                      {
                        label: 'Resume with flags…',
                        icon: () => <SyncIcon size={14} />,
                        title:
                          'Restart this agent and continue its conversation with extra CLI flags.',
                        run: resumeWithFlags.open,
                      },
                    ]}
                    onPromptDetected={(text) => setLastPrompt(props.task.id, text, props.agentId)}
                    onReady={(focusFn) => {
                      terminalFocus = focusFn;
                      props.onReady(a().id, focusCurrentView);
                    }}
                    onTranscriptMarksReady={props.onTranscriptMarksReady}
                    fontSize={13}
                  />
                </Show>
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

/** Restart/switch-agent dropdown menu shown on the exit badge. */
function AgentRestartMenu(props: { agentId: string; agentDefId: string }) {
  const [showAgentMenu, setShowAgentMenu] = createSignal(false);
  let menuRef: HTMLSpanElement | undefined;

  const handleClickOutside = (e: MouseEvent) => {
    if (menuRef && !menuRef.contains(e.target as Node)) {
      setShowAgentMenu(false);
    }
  };

  onMount(() => document.addEventListener('mousedown', handleClickOutside));
  onCleanup(() => document.removeEventListener('mousedown', handleClickOutside));

  return (
    <span style={{ position: 'relative', display: 'inline-flex' }} ref={(el) => (menuRef = el)}>
      <button
        class="btn-with-icon"
        onClick={(e) => {
          e.stopPropagation();
          restartAgent(props.agentId, false);
        }}
        style={{
          background: theme.bgElevated,
          border: `1px solid ${theme.border}`,
          color: theme.fg,
          padding: '2px 8px',
          'border-radius': '4px 0 0 4px',
          'border-right': 'none',
          cursor: 'pointer',
          'font-size': sf(11),
        }}
      >
        <SyncIcon size={12} />
        Restart
      </button>
      <button
        aria-label="More ways to restart"
        aria-expanded={showAgentMenu()}
        onClick={(e) => {
          e.stopPropagation();
          setShowAgentMenu(!showAgentMenu());
        }}
        style={{
          background: theme.bgElevated,
          border: `1px solid ${theme.border}`,
          color: theme.fg,
          padding: '2px 4px',
          'border-radius': '0 4px 4px 0',
          cursor: 'pointer',
          'font-size': sf(11),
        }}
      >
        ▾
      </button>
      <Show when={showAgentMenu()}>
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: '0',
            'margin-top': '4px',
            background: theme.bgElevated,
            border: `1px solid ${theme.border}`,
            'border-radius': 'var(--radius-sm)',
            padding: '4px 0',
            'z-index': '20',
            'min-width': '160px',
            'box-shadow': '0 4px 12px rgba(0,0,0,0.3)',
          }}
        >
          <div
            style={{
              padding: '4px 10px',
              'font-size': sf(11),
              color: theme.fgMuted,
            }}
          >
            Restart with…
          </div>
          <For each={store.availableAgents.filter((ag) => ag.available !== false)}>
            {(agentDef) => (
              <button
                title={agentDef.description}
                onClick={(e) => {
                  e.stopPropagation();
                  setShowAgentMenu(false);
                  if (agentDef.id === props.agentDefId) {
                    restartAgent(props.agentId, false);
                  } else {
                    switchAgent(props.agentId, agentDef);
                  }
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  background: agentDef.id === props.agentDefId ? theme.bgSelected : 'transparent',
                  border: 'none',
                  color: theme.fg,
                  padding: '5px 10px',
                  cursor: 'pointer',
                  'font-size': sf(11),
                  'text-align': 'left',
                }}
                onMouseEnter={(e) => {
                  if (agentDef.id !== props.agentDefId)
                    e.currentTarget.style.background = theme.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background =
                    agentDef.id === props.agentDefId ? theme.bgSelected : 'transparent';
                }}
              >
                {agentDef.name}
                <Show when={agentDef.id === props.agentDefId}>
                  {' '}
                  <span style={{ opacity: 0.5 }}>(current)</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </span>
  );
}
