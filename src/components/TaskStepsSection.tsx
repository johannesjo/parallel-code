import { Show, For, createSignal, createMemo, createEffect, onCleanup, onMount } from 'solid-js';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { useFocusRegistration } from '../lib/focus-registration';
import { setTaskFocusedPanel } from '../store/store';
import type { Task } from '../store/types';
import type { StepEntry } from '../ipc/types';

const STATUS_COLORS: Record<string, string> = {
  starting: '#fb923c',
  investigating: '#60a5fa',
  implementing: '#c084fc',
  testing: '#e5a800',
  awaiting_review: '#f87171',
  done: theme.success,
};

function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? theme.fgMuted;
}

/** Visual offset applied to a sub-agent step. The collapsed history row absorbs this
 *  via padding; the latest card via margin; the expanded detail panel adds it on top
 *  of the base 32px indent so the detail aligns under the row's text. */
const SUB_AGENT_INDENT_PX = 16;

/** Append Z when no timezone is present — ISO strings without TZ are parsed as local time. */
function normalizeIsoTimestamp(ts: string): string {
  if (!ts) return '';
  return ts.endsWith('Z') || /[+-]\d{2}:/.test(ts.slice(-6)) ? ts : ts + 'Z';
}

function relativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(normalizeIsoTimestamp(timestamp)).getTime();
  if (isNaN(then)) return '';
  const diffMs = now - then;
  if (diffMs < 60_000) return 'just now';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/** Compute elapsed time between two ISO timestamps. Returns "45s", "2m", "1h". */
function stepDuration(fromTs: string, toTs: string): string {
  const from = new Date(normalizeIsoTimestamp(fromTs)).getTime();
  const to = new Date(normalizeIsoTimestamp(toTs)).getTime();
  if (isNaN(from) || isNaN(to)) return '';
  const secs = Math.floor(Math.max(0, to - from) / 1_000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h`;
}

interface TaskStepsSectionProps {
  task: Task;
  isActive: boolean;
  onFileClick?: (file: string) => void;
  onNaturalHeight?: (h: number) => void;
  /** Scroll the AI terminal to the moment a given step index was recorded.
   *  Only steps marked since the terminal mounted are jumpable — historical
   *  steps (written before this session) have no marker and can't be located. */
  onJumpToStep?: (stepIndex: number) => boolean;
  /** Steps with `index < firstJumpableIndex` don't have a terminal marker and
   *  therefore shouldn't show the ↗ button. */
  firstJumpableIndex?: number;
}

/** Clickable file path badge shown on step cards. */
function FileBadge(props: { file: string; onFileClick?: (file: string) => void }) {
  return (
    <span
      onClick={(e) => {
        if (!props.onFileClick) return;
        e.stopPropagation();
        props.onFileClick(props.file);
      }}
      onMouseEnter={(e) => {
        if (props.onFileClick)
          e.currentTarget.style.background = `color-mix(in srgb, ${theme.fgMuted} 20%, transparent)`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = `color-mix(in srgb, ${theme.fgMuted} 10%, transparent)`;
      }}
      style={{
        'font-size': sf(10),
        padding: '1px 6px',
        'border-radius': '3px',
        background: `color-mix(in srgb, ${theme.fgMuted} 10%, transparent)`,
        color: theme.fgMuted,
        border: `1px solid ${theme.border}`,
        cursor: props.onFileClick ? 'pointer' : 'default',
      }}
    >
      {props.file}
    </span>
  );
}

/** Hash agent_id to a stable hue so multiple concurrent sub-agents are distinguishable
 *  at a glance. Kept mid-saturation / dim so chips don't compete with status color. */
function agentChipHue(agentId: string): number {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0;
  return hash % 360;
}

/** Tiny gutter chip identifying a sub-agent. Replaces both the step index and the
 *  previous dashed agent badge for rows owned by a sub-agent. Full id shown on hover. */
function AgentChip(props: { agentId: string }) {
  const hue = () => agentChipHue(props.agentId);
  const letter = () => (props.agentId.charAt(0) || '?').toUpperCase();
  return (
    <span
      title={`Sub-agent: ${props.agentId}`}
      style={{
        width: '18px',
        height: '14px',
        'border-radius': '3px',
        background: `hsl(${hue()}, 45%, 30%)`,
        color: `hsl(${hue()}, 70%, 82%)`,
        'font-size': sf(9),
        'font-weight': '600',
        display: 'inline-flex',
        'align-items': 'center',
        'justify-content': 'center',
        'flex-shrink': '0',
        'font-family': "'JetBrains Mono', monospace",
      }}
    >
      {letter()}
    </span>
  );
}

/** Leading sub-agent banner shown above a step's main row. Stacking sub-agent info
 *  on its own line keeps the summary row uncluttered when agent_id, status, and
 *  summary would otherwise compete for horizontal space. */
function AgentHeader(props: { agentId: string }) {
  return (
    <div
      style={{
        display: 'flex',
        'align-items': 'center',
        gap: '5px',
        'margin-bottom': '3px',
      }}
    >
      <AgentChip agentId={props.agentId} />
      <span
        title={`Sub-agent: ${props.agentId}`}
        style={{
          'font-size': sf(10),
          color: theme.fgMuted,
          'font-family': "'JetBrains Mono', monospace",
          overflow: 'hidden',
          'text-overflow': 'ellipsis',
          'white-space': 'nowrap',
          'min-width': '0',
        }}
      >
        {props.agentId}
      </span>
    </div>
  );
}

/** Compact colored dot that replaces the previous status pill. Status text is available
 *  via the title attribute for accessibility / hover disclosure. */
function StatusDot(props: { status: string }) {
  return (
    <span
      title={props.status.replaceAll('_', ' ')}
      style={{
        width: '6px',
        height: '6px',
        'border-radius': '50%',
        background: statusColor(props.status),
        'flex-shrink': '0',
        display: 'inline-block',
      }}
    />
  );
}

/** Inline copy-to-clipboard control. Only meaningful on hover (parent toggles `visible`). */
function CopyButton(props: { text: string; visible: boolean; label: string }) {
  const [copied, setCopied] = createSignal(false);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    if (resetTimer !== undefined) clearTimeout(resetTimer);
  });
  return (
    <button
      type="button"
      title={`Copy ${props.label}`}
      aria-label={`Copy ${props.label}`}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard
          .writeText(props.text)
          .then(() => {
            setCopied(true);
            if (resetTimer !== undefined) clearTimeout(resetTimer);
            resetTimer = setTimeout(() => {
              resetTimer = undefined;
              setCopied(false);
            }, 1200);
          })
          .catch(() => {});
      }}
      style={{
        background: 'transparent',
        border: 'none',
        padding: '0 4px',
        cursor: 'pointer',
        color: copied() ? theme.success : theme.fgSubtle,
        opacity: props.visible || copied() ? 1 : 0,
        transition: 'opacity 120ms',
        'font-size': sf(11),
        'flex-shrink': '0',
        'line-height': '1',
      }}
    >
      {copied() ? '✓' : '⧉'}
    </button>
  );
}

function JumpButton(props: { onClick: () => void; visible: boolean }) {
  return (
    <button
      type="button"
      title="Jump to terminal moment"
      aria-label="Jump to terminal moment"
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
      style={{
        background: 'transparent',
        border: 'none',
        padding: '0 4px',
        cursor: 'pointer',
        color: theme.fgSubtle,
        opacity: props.visible ? 1 : 0,
        transition: 'opacity 120ms',
        'font-size': sf(11),
        'flex-shrink': '0',
        'line-height': '1',
      }}
    >
      ↗
    </button>
  );
}

function WaitingIndicator(props: { fontSize: string }) {
  return (
    <>
      <span
        class="status-dot-pulse"
        style={{
          width: '5px',
          height: '5px',
          'border-radius': '50%',
          background: theme.fgSubtle,
          display: 'inline-block',
          'flex-shrink': '0',
        }}
      />
      <span style={{ 'font-size': props.fontSize, color: theme.fgSubtle }}>
        Waiting for next step
      </span>
    </>
  );
}

export function TaskStepsSection(props: TaskStepsSectionProps) {
  const [expandedHistory, setExpandedHistory] = createSignal<Set<number>>(new Set());
  const [hoveredHistory, setHoveredHistory] = createSignal<number | null>(null);
  const [latestHovered, setLatestHovered] = createSignal<'summary' | 'detail' | null>(null);
  let scrollRef!: HTMLDivElement;
  const [latestCardRef, setLatestCardRef] = createSignal<HTMLDivElement | undefined>();

  onMount(() => {
    useFocusRegistration(`${props.task.id}:steps`, () => scrollRef?.focus());
  });

  const steps = () => props.task.stepsContent ?? [];
  const latestStep = createMemo(() => {
    const s = steps();
    return s.length > 0 ? s[s.length - 1] : null;
  });
  const historySteps = createMemo<StepEntry[]>(() => {
    const s = steps();
    if (s.length <= 1) return [];
    return s.slice(0, -1);
  });
  const isInteracting = createMemo(() => {
    const li = props.task.lastInputAt;
    if (!li) return false;
    const last = latestStep();
    if (!last) return true;
    return Date.parse(li) > Date.parse(normalizeIsoTimestamp(last.timestamp));
  });

  createEffect(() => {
    const len = steps().length;
    if (len > 0 && scrollRef) {
      scrollRef.scrollTop = scrollRef.scrollHeight;
    }
  });

  const reportHeight = () => {
    const el = latestCardRef();
    if (!el) return;
    const indicatorH = isInteracting() ? 28 : 0;
    props.onNaturalHeight?.(el.offsetHeight + indicatorH + 24);
  };

  createEffect(() => {
    // Re-measure when the step content, interaction state, or card ref changes.
    latestStep();
    isInteracting();
    latestCardRef();
    reportHeight();
  });

  createEffect(() => {
    const el = latestCardRef();
    if (!el) return;
    const ro = new ResizeObserver(() => reportHeight());
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });

  function toggleHistory(originalIndex: number) {
    setExpandedHistory((prev) => {
      const next = new Set(prev);
      if (next.has(originalIndex)) {
        next.delete(originalIndex);
      } else {
        next.add(originalIndex);
      }
      return next;
    });
  }

  return (
    <div
      class="focusable-panel"
      style={{
        height: '100%',
        display: 'flex',
        'flex-direction': 'column',
        background: theme.taskPanelBg,
        'border-radius': '6px',
      }}
    >
      <Show when={steps().length === 0}>
        <div
          style={{
            height: '28px',
            display: 'flex',
            'align-items': 'center',
            padding: '0 8px',
            gap: '6px',
          }}
        >
          <span
            style={{
              'font-size': sf(11),
              'font-weight': '600',
              color: theme.fgMuted,
              'text-transform': 'uppercase',
              'letter-spacing': '0.05em',
            }}
          >
            Steps
          </span>
          <Show
            when={isInteracting()}
            fallback={
              <span style={{ 'font-size': sf(11), color: theme.fgSubtle }}>waiting...</span>
            }
          >
            <WaitingIndicator fontSize={sf(11)} />
          </Show>
        </div>
      </Show>

      <Show when={steps().length > 0}>
        <div
          ref={scrollRef}
          tabIndex={0}
          onClick={() => setTaskFocusedPanel(props.task.id, 'steps')}
          onKeyDown={(e) => {
            if (e.altKey) return;
            const SCROLL_STEP_PX = 60;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              scrollRef.scrollBy({ top: SCROLL_STEP_PX, behavior: 'smooth' });
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              scrollRef.scrollBy({ top: -SCROLL_STEP_PX, behavior: 'smooth' });
            } else if (e.key === 'PageDown') {
              e.preventDefault();
              scrollRef.scrollBy({ top: scrollRef.clientHeight, behavior: 'smooth' });
            } else if (e.key === 'PageUp') {
              e.preventDefault();
              scrollRef.scrollBy({ top: -scrollRef.clientHeight, behavior: 'smooth' });
            }
          }}
          style={{
            flex: '1',
            overflow: 'auto',
            padding: '0 8px 8px',
            display: 'flex',
            'flex-direction': 'column',
            gap: '6px',
            outline: 'none',
          }}
        >
          <Show when={historySteps().length > 0}>
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '0' }}>
              <For each={historySteps()}>
                {(step, idx) => {
                  const isExpanded = () => expandedHistory().has(idx());
                  const isHovered = () => hoveredHistory() === idx();
                  const prevStep = () => (idx() > 0 ? historySteps()[idx() - 1] : null);
                  // Phase divider when status changes between adjacent entries.
                  const phaseChanged = () => {
                    const p = prevStep();
                    if (!p) return false;
                    return String(p.status ?? '') !== String(step.status ?? '');
                  };
                  const indented = () => Boolean(step.agent_id);

                  return (
                    <div>
                      <Show when={phaseChanged()}>
                        <div
                          style={{
                            height: '1px',
                            background: theme.border,
                            margin: '4px 0 4px 8px',
                            opacity: 0.5,
                          }}
                        />
                      </Show>
                      <div
                        onClick={() => toggleHistory(idx())}
                        onMouseEnter={() => setHoveredHistory(idx())}
                        onMouseLeave={() => setHoveredHistory(null)}
                        style={{
                          display: 'flex',
                          'flex-direction': 'column',
                          cursor: 'pointer',
                          'border-radius': '4px',
                          'user-select': 'none',
                          padding: indented() ? '4px 6px 3px 8px' : '0 6px 0 8px',
                          'margin-left': indented() ? `${SUB_AGENT_INDENT_PX}px` : '0',
                          background: isHovered()
                            ? `color-mix(in srgb, ${theme.fgMuted} 8%, transparent)`
                            : 'transparent',
                        }}
                      >
                        <Show when={step.agent_id}>
                          <AgentHeader agentId={step.agent_id ?? ''} />
                        </Show>
                        <div
                          style={{
                            display: 'flex',
                            'align-items': 'center',
                            gap: '8px',
                            padding: indented() ? '0' : '3px 0',
                          }}
                        >
                          <StatusDot status={String(step.status ?? '')} />
                          <span
                            style={{
                              'font-size': sf(12),
                              'font-weight': '600',
                              color: theme.fg,
                              overflow: 'hidden',
                              'text-overflow': 'ellipsis',
                              'white-space': 'nowrap',
                              flex: '1',
                            }}
                          >
                            {step.summary ?? ''}
                          </span>
                          <CopyButton
                            text={step.summary ?? ''}
                            visible={isHovered()}
                            label="summary"
                          />
                          <Show
                            when={props.onJumpToStep && idx() >= (props.firstJumpableIndex ?? 0)}
                          >
                            <JumpButton
                              visible={isHovered()}
                              onClick={() => props.onJumpToStep?.(idx())}
                            />
                          </Show>
                          <Show when={step.timestamp}>
                            <span
                              style={{
                                'font-size': sf(9),
                                color: theme.fgSubtle,
                                'flex-shrink': '0',
                              }}
                            >
                              {stepDuration(
                                step.timestamp,
                                steps()[idx() + 1]?.timestamp ?? new Date().toISOString(),
                              )}
                            </span>
                          </Show>
                          <Show when={(step.files_touched?.length ?? 0) > 0}>
                            <span
                              style={{
                                'font-size': sf(9),
                                color: theme.fgSubtle,
                                'flex-shrink': '0',
                              }}
                            >
                              {step.files_touched?.length ?? 0}{' '}
                              {(step.files_touched?.length ?? 0) === 1 ? 'file' : 'files'}
                            </span>
                          </Show>
                        </div>
                      </div>

                      <Show when={isExpanded()}>
                        <div
                          style={{
                            'margin-left': indented() ? `${14 + SUB_AGENT_INDENT_PX}px` : '14px',
                            padding: '4px 8px',
                            'font-size': sf(12),
                            color: theme.fgMuted,
                            'border-left': `1px solid ${theme.border}`,
                          }}
                        >
                          <Show when={step.timestamp}>
                            <div
                              style={{
                                'font-size': sf(9),
                                color: theme.fgSubtle,
                                'margin-bottom': '4px',
                              }}
                            >
                              {relativeTime(step.timestamp)}
                            </div>
                          </Show>
                          <Show when={step.detail}>
                            <div
                              style={{
                                display: 'flex',
                                'align-items': 'flex-start',
                                gap: '4px',
                                'margin-bottom': '4px',
                              }}
                            >
                              <div style={{ flex: '1', 'line-height': '1.45' }}>{step.detail}</div>
                              <CopyButton text={step.detail ?? ''} visible label="detail" />
                            </div>
                          </Show>
                          <Show
                            when={
                              Array.isArray(step.files_touched) && step.files_touched.length > 0
                            }
                          >
                            <div
                              style={{
                                display: 'flex',
                                'flex-wrap': 'wrap',
                                gap: '3px',
                              }}
                            >
                              <For each={step.files_touched}>
                                {(file) => (
                                  <FileBadge file={file} onFileClick={props.onFileClick} />
                                )}
                              </For>
                            </div>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>

          {/* Latest step — always expanded, anchored at bottom */}
          <Show when={latestStep()}>
            {(step) => {
              const indented = () => Boolean(step().agent_id);
              return (
                <div
                  ref={setLatestCardRef}
                  style={{
                    'border-radius': '6px',
                    padding: '6px 10px 8px',
                    'margin-left': indented() ? `${SUB_AGENT_INDENT_PX}px` : '0',
                  }}
                >
                  <Show when={step().agent_id}>
                    <AgentHeader agentId={step().agent_id ?? ''} />
                  </Show>
                  <div
                    onMouseEnter={() => setLatestHovered('summary')}
                    onMouseLeave={() => setLatestHovered(null)}
                    style={{
                      display: 'flex',
                      'align-items': 'center',
                      gap: '8px',
                      'margin-bottom': '4px',
                    }}
                  >
                    <StatusDot status={String(step().status ?? '')} />
                    <span
                      style={{
                        'font-size': sf(12),
                        'font-weight': '600',
                        color: theme.fg,
                        flex: '1',
                        'line-height': '1.4',
                      }}
                    >
                      {step().summary ?? ''}
                    </span>
                    <CopyButton
                      text={step().summary ?? ''}
                      visible={latestHovered() === 'summary'}
                      label="summary"
                    />
                    <Show
                      when={
                        props.onJumpToStep && steps().length - 1 >= (props.firstJumpableIndex ?? 0)
                      }
                    >
                      <JumpButton
                        visible={latestHovered() === 'summary'}
                        onClick={() => {
                          const len = steps().length;
                          if (len > 0) props.onJumpToStep?.(len - 1);
                        }}
                      />
                    </Show>
                    <Show when={step().timestamp}>
                      <span
                        style={{ 'font-size': sf(10), color: theme.fgSubtle, 'flex-shrink': '0' }}
                      >
                        {relativeTime(step().timestamp)}
                      </span>
                    </Show>
                  </div>
                  <Show when={step().detail}>
                    <div
                      onMouseEnter={() => setLatestHovered('detail')}
                      onMouseLeave={() => setLatestHovered(null)}
                      style={{
                        display: 'flex',
                        'align-items': 'flex-start',
                        gap: '4px',
                        'font-size': sf(12),
                        color: theme.fgMuted,
                        'margin-top': '4px',
                        'line-height': '1.4',
                      }}
                    >
                      <div style={{ flex: '1' }}>{step().detail}</div>
                      <CopyButton
                        text={step().detail ?? ''}
                        visible={latestHovered() === 'detail'}
                        label="detail"
                      />
                    </div>
                  </Show>
                  <Show when={(step().files_touched ?? []).length > 0}>
                    <div
                      style={{
                        display: 'flex',
                        'flex-wrap': 'wrap',
                        gap: '4px',
                        'margin-top': '6px',
                      }}
                    >
                      <For each={step().files_touched}>
                        {(file) => <FileBadge file={file} onFileClick={props.onFileClick} />}
                      </For>
                    </div>
                  </Show>
                </div>
              );
            }}
          </Show>

          <Show when={isInteracting()}>
            <div
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '5px',
                padding: '4px 2px 2px',
              }}
            >
              <WaitingIndicator fontSize={sf(10)} />
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
