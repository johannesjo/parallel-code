import { Show, For, createSignal, createEffect, onMount, onCleanup } from 'solid-js';

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
} from '../store/store';
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
import type { PromptInputHandle } from './PromptInput';

interface TaskAITerminalProps {
  task: Task;
  isActive: boolean;
  promptHandle: PromptInputHandle | undefined;
  /** Receives a function that scrolls the AI terminal to the moment a given step
   *  index was recorded, along with the first step index that is jumpable — steps
   *  below that index were written before the current terminal mount and have no
   *  marker. Called with `undefined` jump when the terminal unmounts. */
  onStepJumpReady?: (
    jump: ((stepIndex: number) => boolean) | undefined,
    firstJumpableIndex: number,
  ) => void;
}

export function TaskAITerminal(props: TaskAITerminalProps) {
  onCleanup(() => unregisterFocusFn(`${props.task.id}:ai-terminal`));

  const dockerOverlayLabel = () => getTaskDockerOverlayLabel(props.task.dockerSource);

  // Step bookmarks — TerminalView hands us a mark/jump API once the xterm
  // instance is ready. We only mark steps that arrive while the terminal is live;
  // historical steps written before this mount aren't jumpable (anchoring them
  // all at line 0 was the source of the original "jump to" bug).
  let stepNav: { mark: (i: number) => void; jump: (i: number) => boolean } | undefined;
  let lastMarkedLen = 0;
  onCleanup(() => props.onStepJumpReady?.(undefined, 0));

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
  const [mdViewerOpen, setMdViewerOpen] = createSignal(false);

  const firstAgent = () => {
    const ids = props.task.agentIds;
    return ids.length > 0 ? store.agents[ids[0]] : undefined;
  };

  const fileNameFromPath = (filePath: string) => filePath.split('/').pop() ?? filePath;

  const infoBarStatus = () => {
    if (firstAgent()?.status === 'exited' && props.task.initialPrompt) {
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

  function handleFileLink(filePath: string) {
    invoke<string>(IPC.ReadFileText, { filePath })
      .then((content) => {
        setMdViewerContent(content);
        setMdViewerFileName(fileNameFromPath(filePath));
        setMdViewerOpen(true);
      })
      .catch((err) => {
        setMdViewerContent(`**Error loading file:** ${String(err)}`);
        setMdViewerFileName(fileNameFromPath(filePath));
        setMdViewerOpen(true);
      });
  }

  return (
    <>
      <div
        class="focusable-panel shell-terminal-container"
        data-shell-focused={store.focusedPanel[props.task.id] === 'ai-terminal' ? 'true' : 'false'}
        style={{
          height: '100%',
          position: 'relative',
          background: theme.taskPanelBg,
          display: 'flex',
          'flex-direction': 'column',
        }}
        onClick={() => setTaskFocusedPanel(props.task.id, 'ai-terminal')}
      >
        <InfoBar
          title={props.task.lastPrompt || infoBarStatus().title}
          onDblClick={() => {
            if (props.task.lastPrompt && props.promptHandle && !props.promptHandle.getText())
              props.promptHandle.setText(props.task.lastPrompt);
          }}
        >
          <span style={{ opacity: props.task.lastPrompt ? 1 : 0.4 }}>
            {props.task.lastPrompt ? `> ${props.task.lastPrompt}` : infoBarStatus().text}
          </span>
        </InfoBar>
        <div style={{ flex: '1', position: 'relative', overflow: 'hidden' }}>
          <Show when={props.task.dockerMode}>
            <div
              title={props.task.dockerImage}
              style={{
                position: 'absolute',
                top: '8px',
                left: '12px',
                'z-index': '10',
                'font-size': sf(11),
                color: theme.fgMuted,
                background: 'color-mix(in srgb, var(--island-bg) 80%, transparent)',
                padding: '2px 8px',
                'border-radius': '6px',
                border: `1px solid ${theme.border}`,
                'pointer-events': 'none',
              }}
            >
              {dockerOverlayLabel()}
            </div>
          </Show>
          <Show when={firstAgent()}>
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
                    isFocused={
                      props.isActive && store.focusedPanel[props.task.id] === 'ai-terminal'
                    }
                    command={a().def.command}
                    args={[
                      ...(a().resumed && a().def.resume_args?.length
                        ? (a().def.resume_args ?? [])
                        : a().def.args),
                      ...(props.task.skipPermissions && a().def.skip_permissions_args?.length
                        ? (a().def.skip_permissions_args ?? [])
                        : []),
                    ]}
                    cwd={props.task.worktreePath}
                    stepsEnabled={props.task.stepsEnabled}
                    dockerMode={props.task.dockerMode}
                    dockerImage={props.task.dockerImage}
                    onExit={(code) => markAgentExited(a().id, code)}
                    onData={(data) => markAgentOutput(a().id, data, props.task.id)}
                    onFileLink={handleFileLink}
                    onPromptDetected={(text) => setLastPrompt(props.task.id, text)}
                    onReady={(focusFn) => registerFocusFn(`${props.task.id}:ai-terminal`, focusFn)}
                    onStepNavReady={(api) => {
                      if (!api) {
                        // TerminalView unmounting (agent restart). Drop the stale API
                        // and reset the watermark so the next mount starts fresh.
                        stepNav = undefined;
                        lastMarkedLen = 0;
                        props.onStepJumpReady?.(undefined, 0);
                        return;
                      }
                      stepNav = api;
                      // Skip historical steps — we can't know which terminal line each
                      // one was originally written at, and anchoring them all at the
                      // current line would silently mis-route every jump. Steps below
                      // `firstJumpable` therefore don't get a ↗ button in the UI.
                      const firstJumpable = props.task.stepsContent?.length ?? 0;
                      lastMarkedLen = firstJumpable;
                      props.onStepJumpReady?.(api.jump, firstJumpable);
                    }}
                    fontSize={14}
                  />
                </Show>
              </>
            )}
          </Show>
        </div>
      </div>
      <MarkdownViewerDialog
        open={mdViewerOpen()}
        onClose={() => setMdViewerOpen(false)}
        content={mdViewerContent()}
        fileName={mdViewerFileName()}
      />
    </>
  );
}

function MarkdownViewerDialog(props: {
  open: boolean;
  onClose: () => void;
  content: string;
  fileName: string;
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
