import { Show, For, createSignal, createMemo, createEffect, onMount } from 'solid-js';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { badgeStyle } from '../lib/badgeStyle';
import { ScalablePanel } from './ScalablePanel';
import { useFocusRegistration } from '../lib/focus-registration';
import { setTaskFocusedPanel } from '../store/store';
import type { Task } from '../store/types';

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

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

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

interface TaskStepsSectionProps {
  task: Task;
  isActive: boolean;
  onFileClick?: (file: string) => void;
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
        'font-size': sf(9),
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
  let scrollRef!: HTMLDivElement;

  onMount(() => {
    useFocusRegistration(`${props.task.id}:steps`, () => scrollRef?.focus());
  });

  const steps = () => props.task.stepsContent ?? [];
  const latestStep = createMemo(() => {
    const s = steps();
    return s.length > 0 ? s[s.length - 1] : null;
  });
  const historySteps = createMemo(() => {
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
    <ScalablePanel panelId={`${props.task.id}:steps`}>
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
        {/* Waiting placeholder — shown when steps tracking is on but no steps written yet */}
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
                'font-size': sf(10),
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
                <span style={{ 'font-size': sf(10), color: theme.fgSubtle }}>waiting...</span>
              }
            >
              <WaitingIndicator fontSize={sf(10)} />
            </Show>
          </div>
        </Show>

        {/* Scrollable content — keyboard-navigable when focused */}
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
            {/* History — collapsible entries */}
            <Show when={historySteps().length > 0}>
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
                <For each={historySteps()}>
                  {(step, idx) => {
                    const isExpanded = () => expandedHistory().has(idx());

                    return (
                      <div>
                        <div
                          onClick={() => toggleHistory(idx())}
                          style={{
                            display: 'flex',
                            'align-items': 'center',
                            gap: '6px',
                            padding: '3px 6px 3px 0',
                            cursor: 'pointer',
                            'border-radius': '4px',
                            'user-select': 'none',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = `color-mix(in srgb, ${theme.fgMuted} 8%, transparent)`;
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'transparent';
                          }}
                        >
                          <span
                            style={{
                              'font-size': sf(9),
                              color: theme.fgSubtle,
                              'flex-shrink': '0',
                              width: '20px',
                              'text-align': 'right',
                            }}
                          >
                            {idx() + 1}
                          </span>
                          <span
                            style={{
                              ...badgeStyle(statusColor(String(step.status ?? ''))),
                              'font-size': sf(9),
                              padding: '1px 5px',
                            }}
                          >
                            {String(step.status ?? '').replaceAll('_', ' ')}
                          </span>
                          <span
                            style={{
                              'font-size': sf(11),
                              'font-weight': '600',
                              color: theme.fg,
                              overflow: 'hidden',
                              'text-overflow': 'ellipsis',
                              'white-space': 'nowrap',
                              flex: '1',
                            }}
                          >
                            {truncate(step.summary ?? '', 140)}
                          </span>
                        </div>

                        <Show when={isExpanded()}>
                          <div
                            style={{
                              'margin-left': '32px',
                              padding: '4px 8px',
                              'font-size': sf(11),
                              color: theme.fgMuted,
                              'border-left': `2px solid ${theme.border}`,
                            }}
                          >
                            <Show when={step.detail}>
                              <div style={{ 'margin-bottom': '4px' }}>
                                {truncate(step.detail ?? '', 280)}
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
              {(step) => (
                <div
                  style={{
                    'border-radius': '6px',
                    padding: '8px 10px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      'align-items': 'center',
                      gap: '8px',
                      'margin-bottom': '4px',
                    }}
                  >
                    <span style={badgeStyle(statusColor(String(step().status ?? '')))}>
                      {String(step().status ?? '').replaceAll('_', ' ')}
                    </span>
                    <span
                      style={{
                        'font-size': sf(11),
                        'font-weight': '600',
                        color: theme.fg,
                        flex: '1',
                      }}
                    >
                      {truncate(step().summary ?? '', 140)}
                    </span>
                    <Show when={step().timestamp}>
                      <span
                        style={{ 'font-size': sf(9), color: theme.fgSubtle, 'flex-shrink': '0' }}
                      >
                        {relativeTime(step().timestamp)}
                      </span>
                    </Show>
                  </div>
                  <Show when={step().detail}>
                    <div
                      style={{
                        'font-size': sf(11),
                        color: theme.fgMuted,
                        'margin-top': '4px',
                        'line-height': '1.4',
                      }}
                    >
                      {truncate(step().detail ?? '', 280)}
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
              )}
            </Show>

            {/* Interacting indicator — shown when user sent input after last step */}
            <Show when={isInteracting()}>
              <div
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  gap: '5px',
                  padding: '4px 2px 2px',
                }}
              >
                <WaitingIndicator fontSize={sf(9)} />
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </ScalablePanel>
  );
}
