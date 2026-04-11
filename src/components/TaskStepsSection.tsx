import { Show, For, createSignal } from 'solid-js';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { badgeStyle } from '../lib/badgeStyle';
import { ScalablePanel } from './ScalablePanel';
import type { Task } from '../store/types';

const STATUS_COLORS: Record<string, string> = {
  investigating: '#60a5fa',
  implementing: '#c084fc',
  testing: '#e5a800',
  awaiting_review: '#f87171',
  done: theme.success,
};

function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? theme.fgMuted;
}

function relativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
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
}

export function TaskStepsSection(props: TaskStepsSectionProps) {
  const [expandedHistory, setExpandedHistory] = createSignal<Set<number>>(new Set());

  const steps = () => props.task.stepsContent ?? [];
  const latestStep = () => {
    const s = steps();
    return s.length > 0 ? s[s.length - 1] : null;
  };
  const historySteps = () => {
    const s = steps();
    if (s.length <= 1) return [];
    return s.slice(0, -1).reverse();
  };

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
        style={{
          height: '100%',
          display: 'flex',
          'flex-direction': 'column',
          background: 'transparent',
        }}
      >
        {/* Header bar */}
        <div
          style={{
            height: '28px',
            'min-height': '28px',
            display: 'flex',
            'align-items': 'center',
            padding: '0 8px',
            gap: '8px',
          }}
        >
          <span
            style={{
              'font-size': sf(10),
              'font-weight': '600',
              color: theme.fgMuted,
              'text-transform': 'uppercase',
              'letter-spacing': '0.05em',
              'flex-shrink': '0',
            }}
          >
            Steps
          </span>
          <Show
            when={latestStep()}
            fallback={
              <span style={{ 'font-size': sf(10), color: theme.fgSubtle }}>No steps yet</span>
            }
          >
            {(step) => (
              <div
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  gap: '6px',
                  overflow: 'hidden',
                  flex: '1',
                  'min-width': '0',
                }}
              >
                <span style={badgeStyle(statusColor(step().status))}>
                  {step().status.replace('_', ' ')}
                </span>
                <span
                  style={{
                    'font-size': sf(10),
                    color: theme.fgMuted,
                    overflow: 'hidden',
                    'text-overflow': 'ellipsis',
                    'white-space': 'nowrap',
                  }}
                >
                  {step().summary}
                </span>
              </div>
            )}
          </Show>
        </div>

        {/* Expanded content */}
        <Show when={steps().length > 0}>
          <div
            style={{
              flex: '1',
              overflow: 'auto',
              padding: '0 8px 8px',
              display: 'flex',
              'flex-direction': 'column',
              gap: '6px',
            }}
          >
            {/* Latest step — always expanded */}
            <Show when={latestStep()}>
              {(step) => (
                <div
                  style={{
                    background: theme.taskPanelBg,
                    'border-radius': '6px',
                    padding: '8px 10px',
                    border: `1px solid ${theme.border}`,
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
                    <span style={badgeStyle(statusColor(step().status))}>
                      {step().status.replace('_', ' ')}
                    </span>
                    <span
                      style={{
                        'font-size': sf(11),
                        'font-weight': '600',
                        color: theme.fg,
                        flex: '1',
                      }}
                    >
                      {step().summary}
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
                        'font-size': sf(10),
                        color: theme.fgMuted,
                        'margin-top': '4px',
                        'line-height': '1.4',
                      }}
                    >
                      {step().detail}
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
                        {(file) => (
                          <span
                            style={{
                              'font-size': sf(9),
                              padding: '1px 6px',
                              'border-radius': '3px',
                              background: `color-mix(in srgb, ${theme.fgMuted} 10%, transparent)`,
                              color: theme.fgMuted,
                              border: `1px solid ${theme.border}`,
                            }}
                          >
                            {file}
                          </span>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              )}
            </Show>

            {/* History — collapsible entries */}
            <Show when={historySteps().length > 0}>
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
                <For each={historySteps()}>
                  {(step, reversedIdx) => {
                    const originalIndex = () => steps().length - 2 - reversedIdx();
                    const isExpanded = () => expandedHistory().has(originalIndex());

                    return (
                      <div>
                        <div
                          onClick={() => toggleHistory(originalIndex())}
                          style={{
                            display: 'flex',
                            'align-items': 'center',
                            gap: '6px',
                            padding: '3px 6px',
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
                            {originalIndex() + 1}
                          </span>
                          <span
                            style={{
                              ...badgeStyle(statusColor(step.status)),
                              'font-size': sf(9),
                              padding: '1px 5px',
                            }}
                          >
                            {step.status.replace('_', ' ')}
                          </span>
                          <span
                            style={{
                              'font-size': sf(10),
                              color: theme.fgMuted,
                              overflow: 'hidden',
                              'text-overflow': 'ellipsis',
                              'white-space': 'nowrap',
                              flex: '1',
                            }}
                          >
                            {step.summary}
                          </span>
                        </div>

                        <Show when={isExpanded()}>
                          <div
                            style={{
                              'margin-left': '32px',
                              padding: '4px 8px',
                              'font-size': sf(10),
                              color: theme.fgMuted,
                              'border-left': `2px solid ${theme.border}`,
                            }}
                          >
                            <Show when={step.detail}>
                              <div style={{ 'margin-bottom': '4px' }}>{step.detail}</div>
                            </Show>
                            <Show when={step.files_touched && step.files_touched.length > 0}>
                              <div
                                style={{
                                  display: 'flex',
                                  'flex-wrap': 'wrap',
                                  gap: '3px',
                                }}
                              >
                                <For each={step.files_touched}>
                                  {(file) => (
                                    <span
                                      style={{
                                        'font-size': sf(9),
                                        padding: '1px 5px',
                                        'border-radius': '3px',
                                        background: `color-mix(in srgb, ${theme.fgMuted} 10%, transparent)`,
                                        color: theme.fgMuted,
                                      }}
                                    >
                                      {file}
                                    </span>
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
          </div>
        </Show>
      </div>
    </ScalablePanel>
  );
}
