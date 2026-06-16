import { Show, For, createSignal, createEffect, onMount, onCleanup, untrack } from 'solid-js';

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
  isPanelFocused,
  setActiveAgent,
  setActiveTask,
  addAgentToTask,
  closeAgentInTask,
  showNotification,
} from '../store/store';
import { warn as logWarn } from '../lib/log';
import { InfoBar } from './InfoBar';
import { TerminalView } from './TerminalView';
import { Dialog } from './Dialog';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { invoke } from '../lib/ipc';
import { getTaskDockerOverlayLabel } from '../lib/docker';
import { IPC } from '../../electron/ipc/channels';
import { createHighlightedMarkdown } from '../lib/marked-shiki';
import type { Task } from '../store/types';
import type { AgentDef } from '../ipc/types';
import type { PromptInputHandle } from './PromptInput';
import { buildTaskAgentArgs, isResumeArgsFailure } from '../lib/agent-args';

function aiTerminalPanelId(agentId: string): string {
  return `ai-terminal:${agentId}`;
}

type StepNavApi = { mark: (i: number) => void; jump: (i: number) => boolean };

interface TaskAITerminalProps {
  task: Task;
  isActive: boolean;
  selectedAgentId: string;
  onSelectAgent?: (agentId: string) => void;
  promptHandle: PromptInputHandle | undefined;
  /** Receives a function that scrolls the AI terminal to the moment a given step
   *  index was recorded, along with the first step index that is jumpable — steps
   *  below that index were written before the current terminal mount and have no
   *  marker. Called with `undefined` jump when the terminal unmounts. */
  onStepJumpReady?: (
    jump: ((stepIndex: number) => boolean) | undefined,
    firstJumpableIndex: number,
  ) => void;
  onFileLink?: (filePath: string) => void;
}

export function TaskAITerminal(props: TaskAITerminalProps) {
  // Step bookmarks — TerminalView hands us a mark/jump API once the xterm
  // instance is ready. We only mark steps that arrive while the terminal is live;
  // historical steps written before this mount aren't jumpable (anchoring them
  // all at line 0 was the source of the original "jump to" bug).
  let stepNav: StepNavApi | undefined;
  let activeStepNavAgentId: string | null = null;
  let lastMarkedLen = 0;
  const stepNavByAgent = new Map<string, StepNavApi>();
  onCleanup(() => props.onStepJumpReady?.(undefined, 0));

  function syncStepNavSource(agentIds = props.task.agentIds) {
    const agentId = agentIds.length === 1 ? agentIds[0] : null;
    const api = agentId ? stepNavByAgent.get(agentId) : undefined;
    if (agentId === activeStepNavAgentId && api === stepNav) return;

    activeStepNavAgentId = agentId;
    stepNav = api;
    if (!api) {
      lastMarkedLen = 0;
      props.onStepJumpReady?.(undefined, 0);
      return;
    }

    const firstJumpable = untrack(() => props.task.stepsContent?.length ?? 0);
    lastMarkedLen = firstJumpable;
    props.onStepJumpReady?.(api.jump, firstJumpable);
  }

  createEffect(() => syncStepNavSource(props.task.agentIds));

  createEffect(() => {
    const len = props.task.stepsContent?.length ?? 0;
    if (!stepNav) return; // Don't advance lastMarkedLen until a terminal is ready.
    if (len <= lastMarkedLen) {
      lastMarkedLen = len;
      return;
    }
    for (let i = lastMarkedLen; i < len; i++) stepNav.mark(i);
    lastMarkedLen = len;
  });

  // --- Markdown file viewer ---
  const [mdViewerContent, setMdViewerContent] = createSignal('');
  const [mdViewerFileName, setMdViewerFileName] = createSignal('');
  const [mdViewerFilePath, setMdViewerFilePath] = createSignal('');
  const [mdViewerOpen, setMdViewerOpen] = createSignal(false);

  const firstAgentId = () => props.task.agentIds[0] ?? '';
  const selectedAgent = () =>
    store.agents[props.selectedAgentId] ?? store.agents[firstAgentId()] ?? undefined;

  const fileNameFromPath = (filePath: string) => filePath.split('/').pop() ?? filePath;

  const infoBarStatus = () => {
    if (selectedAgent()?.status === 'exited' && props.task.initialPrompt) {
      return {
        title: 'Agent exited before prompt was sent',
        text: 'Agent exited before prompt was sent',
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

  function handleFileLink(filePath: string) {
    invoke<string>(IPC.ReadFileText, { filePath })
      .then((content) => {
        setMdViewerContent(content);
        setMdViewerFileName(fileNameFromPath(filePath));
        setMdViewerFilePath(filePath);
        setMdViewerOpen(true);
      })
      .catch((err) => {
        setMdViewerContent(`**Error loading file:** ${String(err)}`);
        setMdViewerFileName(fileNameFromPath(filePath));
        setMdViewerFilePath(filePath);
        setMdViewerOpen(true);
      });
  }

  function handleStepNavReady(agentId: string, api: StepNavApi | undefined) {
    if (!api) {
      stepNavByAgent.delete(agentId);
      syncStepNavSource();
      return;
    }

    stepNavByAgent.set(agentId, api);
    syncStepNavSource();
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
        onClick={() => setTaskFocusedPanel(props.task.id, aiTerminalPanelId(props.selectedAgentId))}
      >
        <InfoBar
          allowOverflow
          title={props.task.lastPrompt || infoBarStatus().title}
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
            <span
              style={{
                opacity: props.task.lastPrompt ? 1 : 0.4,
                flex: '1',
                'min-width': '0',
                overflow: 'hidden',
                'text-overflow': 'ellipsis',
              }}
            >
              {props.task.lastPrompt ? `> ${props.task.lastPrompt}` : infoBarStatus().text}
            </span>
            <div
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '4px',
                'flex-shrink': '0',
              }}
            >
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
                          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
                          </svg>
                        </button>
                      </Show>
                    </span>
                  );
                }}
              </For>
              <AddAgentMenu taskId={props.task.id} />
            </div>
          </div>
        </InfoBar>
        <div
          style={{
            flex: '1',
            display: 'flex',
            gap: props.task.agentIds.length > 1 ? '6px' : '0',
            overflow: 'hidden',
            background: props.task.agentIds.length > 1 ? theme.taskContainerBg : 'transparent',
          }}
        >
          <For each={props.task.agentIds}>
            {(agentId) => (
              <AgentTerminalPane
                task={props.task}
                agentId={agentId}
                canClose={props.task.agentIds.length > 1}
                onSelect={() => selectAgent(agentId)}
                onFileLink={handleFileLink}
                onReady={registerAgentFocus}
                onUnmount={unregisterAgentFocus}
                onStepNavReady={(api) => handleStepNavReady(agentId, api)}
              />
            )}
          </For>
        </div>
      </div>
      <MarkdownViewerDialog
        open={mdViewerOpen()}
        onClose={() => setMdViewerOpen(false)}
        content={mdViewerContent()}
        fileName={mdViewerFileName()}
        filePath={mdViewerFilePath()}
      />
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
          'border-radius': '5px',
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
            'border-radius': '6px',
            padding: '4px 0',
            'z-index': '30',
            'min-width': '180px',
            'box-shadow': '0 4px 12px rgba(0,0,0,0.3)',
          }}
        >
          <div style={{ padding: '4px 10px', 'font-size': sf(10), color: theme.fgMuted }}>
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
  task: Task;
  agentId: string;
  canClose: boolean;
  onSelect: () => void;
  onFileLink: (filePath: string) => void;
  onReady: (agentId: string, focusFn: () => void) => void;
  onUnmount: (agentId: string) => void;
  onStepNavReady?: (
    api: { mark: (i: number) => void; jump: (i: number) => boolean } | undefined,
  ) => void;
}) {
  onCleanup(() => props.onUnmount(props.agentId));

  const dockerOverlayLabel = () => getTaskDockerOverlayLabel(props.task.dockerSource);
  const agent = () => store.agents[props.agentId];

  return (
    <div
      class="focusable-panel shell-terminal-container agent-terminal-pane"
      data-panel-focused={
        isPanelFocused(props.task.id, aiTerminalPanelId(props.agentId)) ? 'true' : 'false'
      }
      style={{
        flex: '1',
        'min-width': props.canClose ? '260px' : '0',
        overflow: 'hidden',
        position: 'relative',
        display: 'flex',
        'flex-direction': 'column',
        background: theme.taskPanelBg,
        border: '1px solid transparent',
      }}
      onClick={(e) => {
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
            'border-radius': '6px',
            border: `1px solid ${theme.border}`,
          }}
        >
          <span title={props.task.dockerImage}>{dockerOverlayLabel()}</span>
        </div>
      </Show>
      <Show when={agent()}>
        {(a) => (
          <>
            <Show when={a().status === 'exited'}>
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
                  'border-radius': '8px',
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
                    onClick={(e) => {
                      e.stopPropagation();
                      restartAgent(a().id, true);
                    }}
                    style={{
                      background: theme.bgElevated,
                      border: `1px solid ${theme.border}`,
                      color: theme.fg,
                      padding: '2px 8px',
                      'border-radius': '4px',
                      cursor: 'pointer',
                      'font-size': sf(11),
                    }}
                  >
                    Resume
                  </button>
                </Show>
              </div>
            </Show>
            <Show when={`${a().id}:${a().generation}`} keyed>
              <TerminalView
                taskId={props.task.id}
                agentId={a().id}
                isFocused={isPanelFocused(props.task.id, aiTerminalPanelId(props.agentId))}
                command={a().def.command}
                args={buildTaskAgentArgs(a().def, props.task, a().resumed)}
                cwd={props.task.worktreePath}
                stepsEnabled={props.task.stepsEnabled}
                dockerMode={
                  props.task.dockerMode ||
                  Boolean(
                    props.task.coordinatedBy && store.tasks[props.task.coordinatedBy]?.dockerMode,
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
                    props.task.coordinatedBy && store.tasks[props.task.coordinatedBy]?.dockerMode,
                  )
                }
                attachExisting={a().attachExisting}
                preserveSessionOnCleanup
                onExit={(code) => {
                  if (
                    a().resumed &&
                    code.exit_code !== 0 &&
                    isResumeArgsFailure(a().def.command, code.last_output)
                  ) {
                    // Resume args failed (e.g. Claude's "No conversation to continue");
                    // fall back to a fresh start with normal args.
                    restartAgent(a().id, false);
                    return;
                  }
                  markAgentExited(a().id, code);
                }}
                onData={(data) => markAgentOutput(a().id, data, props.task.id)}
                onFileLink={props.onFileLink}
                onPromptDetected={(text) => setLastPrompt(props.task.id, text)}
                onReady={(focusFn) => props.onReady(a().id, focusFn)}
                onStepNavReady={props.onStepNavReady}
                fontSize={13}
              />
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

function MarkdownViewerDialog(props: {
  open: boolean;
  onClose: () => void;
  content: string;
  fileName: string;
  filePath: string;
}) {
  const html = createHighlightedMarkdown(() => props.content);

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      width="fit-content"
      panelStyle={{
        width: '80vw',
        'max-width': '1200px',
        height: '80vh',
        overflow: 'hidden',
        padding: '0',
        gap: '0',
        resize: 'both',
      }}
    >
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '10px',
          padding: '12px 20px',
          'border-bottom': `1px solid ${theme.border}`,
          'flex-shrink': '0',
        }}
      >
        <span
          style={{
            'font-size': sf(14),
            color: theme.fg,
            'font-weight': '600',
            'font-family': "'JetBrains Mono', monospace",
          }}
        >
          {props.fileName}
        </span>
        <span style={{ flex: '1' }} />
        <Show when={props.filePath}>
          <button
            onClick={() => {
              invoke(IPC.OpenPath, { filePath: props.filePath }).catch(console.error);
            }}
            style={{
              background: 'transparent',
              border: 'none',
              color: theme.fgMuted,
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
              'align-items': 'center',
              'border-radius': '4px',
            }}
            title="Open in editor"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.5 2a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5v-3a.75.75 0 0 1 1.5 0v3A3 3 0 0 1 12.5 16h-9A3 3 0 0 1 0 12.5v-9A3 3 0 0 1 3.5 0h3a.75.75 0 0 1 0 1.5h-3ZM10 .75a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0V2.56L8.53 8.53a.75.75 0 0 1-1.06-1.06L13.44 1.5H10.75A.75.75 0 0 1 10 .75Z" />
            </svg>
          </button>
        </Show>
        <button
          onClick={() => props.onClose()}
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.fgMuted,
            cursor: 'pointer',
            padding: '4px',
            display: 'flex',
            'align-items': 'center',
            'border-radius': '4px',
          }}
          title="Close"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
          </svg>
        </button>
      </div>
      <div
        style={{
          flex: '1',
          'overflow-y': 'auto',
          padding: '28px 40px',
        }}
      >
        <div
          class="plan-markdown plan-markdown-dialog"
          style={{ color: theme.fg, 'max-width': '100%' }}
          // eslint-disable-next-line solid/no-innerhtml -- local markdown files from worktree
          innerHTML={html()}
        />
      </div>
    </Dialog>
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
        Restart
      </button>
      <button
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
            'border-radius': '6px',
            padding: '4px 0',
            'z-index': '20',
            'min-width': '160px',
            'box-shadow': '0 4px 12px rgba(0,0,0,0.3)',
          }}
        >
          <div
            style={{
              padding: '4px 10px',
              'font-size': sf(10),
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
