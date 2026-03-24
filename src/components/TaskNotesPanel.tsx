import { Show, createSignal, createEffect, onMount } from 'solid-js';
import { store, updateTaskNotes, setTaskFocusedPanel } from '../store/store';
import { ResizablePanel } from './ResizablePanel';
import { ScalablePanel } from './ScalablePanel';
import { ChangedFilesList } from './ChangedFilesList';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { createHighlightedMarkdown } from '../lib/marked-shiki';
import { useFocusRegistration } from '../lib/focus-registration';
import type { Task } from '../store/types';

interface TaskNotesPanelProps {
  task: Task;
  isActive: boolean;
  onPlanFullscreen: () => void;
  onDiffFileClick: (path: string) => void;
}

export function TaskNotesPanel(props: TaskNotesPanelProps) {
  const [notesTab, setNotesTab] = createSignal<'notes' | 'plan'>('notes');
  const planHtml = createHighlightedMarkdown(() => props.task.planContent);

  // Auto-switch to plan tab when plan content first appears
  let hadPlan = false;
  createEffect(() => {
    const hasPlan = store.showPlans && !!props.task.planContent;
    if (hasPlan && !hadPlan) {
      setNotesTab('plan');
    } else if (!hasPlan && hadPlan) {
      setNotesTab('notes');
    }
    hadPlan = hasPlan;
  });

  let notesRef: HTMLTextAreaElement | undefined;
  let planScrollRef: HTMLDivElement | undefined;
  let changedFilesRef: HTMLDivElement | undefined;

  onMount(() => {
    const id = props.task.id;
    useFocusRegistration(`${id}:notes`, () => {
      if (notesTab() === 'plan') {
        planScrollRef?.focus();
      } else {
        notesRef?.focus();
      }
    });
    useFocusRegistration(`${id}:changed-files`, () => {
      changedFilesRef?.focus();
    });
  });

  return (
    <ResizablePanel
      direction="horizontal"
      persistKey={`task:${props.task.id}:notes-split`}
      children={[
        {
          id: 'notes',
          initialSize: 200,
          minSize: 100,
          content: () => (
            <ScalablePanel panelId={`${props.task.id}:notes`}>
              <div
                class="focusable-panel"
                style={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  'flex-direction': 'column',
                }}
                onClick={() => setTaskFocusedPanel(props.task.id, 'notes')}
              >
                <Show when={store.showPlans && props.task.planContent}>
                  <div
                    style={{
                      display: 'flex',
                      'border-bottom': `1px solid ${theme.border}`,
                      'flex-shrink': '0',
                    }}
                  >
                    <button
                      style={{
                        padding: '2px 8px',
                        'font-size': sf(10),
                        background: notesTab() === 'notes' ? theme.taskPanelBg : 'transparent',
                        color: notesTab() === 'notes' ? theme.fg : theme.fgMuted,
                        border: 'none',
                        'border-bottom':
                          notesTab() === 'notes'
                            ? `2px solid ${theme.accent}`
                            : '2px solid transparent',
                        cursor: 'pointer',
                        'font-family': "'JetBrains Mono', monospace",
                      }}
                      onClick={() => setNotesTab('notes')}
                    >
                      Notes
                    </button>
                    <button
                      style={{
                        padding: '2px 8px',
                        'font-size': sf(10),
                        background: notesTab() === 'plan' ? theme.taskPanelBg : 'transparent',
                        color: notesTab() === 'plan' ? theme.fg : theme.fgMuted,
                        border: 'none',
                        'border-bottom':
                          notesTab() === 'plan'
                            ? `2px solid ${theme.accent}`
                            : '2px solid transparent',
                        cursor: 'pointer',
                        'font-family': "'JetBrains Mono', monospace",
                      }}
                      onClick={() => setNotesTab('plan')}
                    >
                      Plan
                    </button>
                  </div>
                </Show>

                <Show when={notesTab() === 'notes' || !store.showPlans || !props.task.planContent}>
                  <textarea
                    ref={(el) => (notesRef = el)}
                    value={props.task.notes}
                    onInput={(e) => updateTaskNotes(props.task.id, e.currentTarget.value)}
                    placeholder="Notes..."
                    style={{
                      width: '100%',
                      flex: '1',
                      background: theme.taskPanelBg,
                      border: 'none',
                      padding: '6px 8px',
                      color: theme.fg,
                      'font-size': sf(11),
                      'font-family': "'JetBrains Mono', monospace",
                      resize: 'none',
                      outline: 'none',
                    }}
                  />
                </Show>

                <Show when={notesTab() === 'plan' && store.showPlans && props.task.planContent}>
                  <div
                    style={{
                      flex: '1',
                      overflow: 'hidden',
                      display: 'flex',
                      'flex-direction': 'column',
                      position: 'relative',
                    }}
                  >
                    <div
                      ref={(el) => (planScrollRef = el)}
                      tabIndex={0}
                      class="plan-markdown"
                      style={{
                        flex: '1',
                        overflow: 'auto',
                        padding: '6px 8px',
                        background: theme.taskPanelBg,
                        color: theme.fg,
                        'font-size': sf(11),
                        'font-family': "'JetBrains Mono', monospace",
                        outline: 'none',
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          props.onPlanFullscreen();
                          return;
                        }
                        if (!planScrollRef) return;
                        const step = 40;
                        const page = Math.max(100, planScrollRef.clientHeight - 40);
                        switch (e.key) {
                          case 'ArrowDown':
                            e.preventDefault();
                            planScrollRef.scrollTop += step;
                            break;
                          case 'ArrowUp':
                            e.preventDefault();
                            planScrollRef.scrollTop -= step;
                            break;
                          case 'PageDown':
                            e.preventDefault();
                            planScrollRef.scrollTop += page;
                            break;
                          case 'PageUp':
                            e.preventDefault();
                            planScrollRef.scrollTop -= page;
                            break;
                          case 'Home':
                            e.preventDefault();
                            planScrollRef.scrollTop = 0;
                            break;
                          case 'End':
                            e.preventDefault();
                            planScrollRef.scrollTop = planScrollRef.scrollHeight;
                            break;
                        }
                      }}
                      // eslint-disable-next-line solid/no-innerhtml -- plan files are local, written by Claude Code in the worktree
                      innerHTML={planHtml()}
                    />
                    <button
                      class="btn-secondary review-plan-btn"
                      style={{
                        position: 'absolute',
                        bottom: '8px',
                        right: '8px',
                        padding: '4px 16px',
                        'font-size': sf(11),
                        'font-family': "'JetBrains Mono', monospace",
                        background: `color-mix(in srgb, ${theme.accent} 12%, ${theme.bgInput})`,
                        color: theme.fg,
                        border: `1px solid color-mix(in srgb, ${theme.accent} 25%, ${theme.border})`,
                        'border-radius': '6px',
                        cursor: 'pointer',
                        'z-index': '1',
                      }}
                      onClick={() => props.onPlanFullscreen()}
                    >
                      Review Plan
                    </button>
                  </div>
                </Show>
              </div>
            </ScalablePanel>
          ),
        },
        {
          id: 'changed-files',
          initialSize: 200,
          minSize: 100,
          content: () => (
            <ScalablePanel panelId={`${props.task.id}:changed-files`}>
              <div
                style={{
                  height: '100%',
                  background: theme.taskPanelBg,
                  display: 'flex',
                  'flex-direction': 'column',
                }}
                onClick={() => setTaskFocusedPanel(props.task.id, 'changed-files')}
              >
                <div
                  style={{
                    padding: '4px 8px',
                    'font-size': sf(10),
                    'font-weight': '600',
                    color: theme.fgMuted,
                    'text-transform': 'uppercase',
                    'letter-spacing': '0.05em',
                    'border-bottom': `1px solid ${theme.border}`,
                    'flex-shrink': '0',
                  }}
                >
                  Changed Files
                </div>
                <div style={{ flex: '1', overflow: 'hidden' }}>
                  <ChangedFilesList
                    worktreePath={props.task.worktreePath}
                    isActive={props.isActive}
                    onFileClick={(file) => props.onDiffFileClick(file.path)}
                    ref={(el) => (changedFilesRef = el)}
                  />
                </div>
              </div>
            </ScalablePanel>
          ),
        },
      ]}
    />
  );
}
