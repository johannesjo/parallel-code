import { For, Show, createSignal } from 'solid-js';
import { store, setActiveTask, createTask, showNotification } from '../store/store';
import { getTaskDotStatus } from '../store/taskStatus';
import { TabDropdownMenu } from './TabDropdownMenu';

export function HeaderTabBar() {
  const [creatingTask, setCreatingTask] = createSignal(false);
  const [inputValue, setInputValue] = createSignal('');
  const [dropdownTaskId, setDropdownTaskId] = createSignal<string | null>(null);
  const [dropdownRect, setDropdownRect] = createSignal<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  let inputRef!: HTMLInputElement;

  function statusColor(taskId: string): string {
    const status = getTaskDotStatus(taskId);
    switch (status) {
      case 'busy':
        return 'var(--warning)';
      case 'ready':
        return 'var(--success)';
      case 'waiting':
      default:
        return 'var(--fg-subtle)';
    }
  }

  function handleChevronClick(taskId: string, e: MouseEvent) {
    e.stopPropagation();
    const btn = e.currentTarget as HTMLElement;
    const rect = btn.getBoundingClientRect();
    if (dropdownTaskId() === taskId) {
      setDropdownTaskId(null);
      setDropdownRect(null);
    } else {
      setDropdownTaskId(taskId);
      setDropdownRect({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    }
  }

  function openInlineInput() {
    setCreatingTask(true);
    setInputValue('');
    requestAnimationFrame(() => inputRef?.focus());
  }

  async function handleCreateTask() {
    const prompt = inputValue().trim();
    if (!prompt) {
      setCreatingTask(false);
      return;
    }

    const projectId = store.lastProjectId;
    if (!projectId) {
      showNotification('No project selected');
      setCreatingTask(false);
      return;
    }

    const agentDef =
      store.availableAgents.find((a) => a.id === 'claude-code') ?? store.availableAgents[0];
    if (!agentDef) {
      showNotification('No agents available');
      setCreatingTask(false);
      return;
    }

    setCreatingTask(false);
    try {
      await createTask({
        name: prompt.slice(0, 50),
        agentDef,
        projectId,
        gitIsolation: 'worktree',
        baseBranch: 'main',
        skipPermissions: true,
        initialPrompt: prompt,
      });
    } catch (err) {
      showNotification(`Failed to create task: ${String(err)}`);
    }
  }

  function handleInputKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCreateTask();
    } else if (e.key === 'Escape') {
      setCreatingTask(false);
    }
  }

  function handleInputBlur() {
    if (!inputValue().trim()) {
      setCreatingTask(false);
    }
  }

  return (
    <div
      style={{
        height: '36px',
        'min-height': '36px',
        display: 'flex',
        'align-items': 'center',
        background: 'var(--bg-elevated)',
        'border-bottom': '1px solid var(--border-subtle)',
        'padding-left': '8px',
        'padding-right': '8px',
        gap: '0',
        overflow: 'hidden',
        'font-family': 'var(--font-ui)',
        'font-size': '12px',
        'user-select': 'none',
        '-webkit-app-region': 'no-drag',
      }}
    >
      <For each={store.taskOrder}>
        {(taskId) => {
          const task = () => store.tasks[taskId];
          const isActive = () => store.activeTaskId === taskId;

          return (
            <Show when={task()}>
              <div
                onClick={() => setActiveTask(taskId)}
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  gap: '6px',
                  padding: '0 10px',
                  height: '28px',
                  'border-radius': '6px',
                  cursor: 'pointer',
                  background: isActive() ? 'var(--bg-selected)' : 'transparent',
                  color: isActive() ? 'var(--fg)' : 'var(--fg-muted)',
                  'white-space': 'nowrap',
                  'flex-shrink': '0',
                  transition: 'background 0.1s',
                }}
              >
                {/* Status dot */}
                <div
                  style={{
                    width: '7px',
                    height: '7px',
                    'border-radius': '50%',
                    background: statusColor(taskId),
                    'flex-shrink': '0',
                  }}
                />
                {/* Task name */}
                <span
                  style={{
                    'max-width': '120px',
                    overflow: 'hidden',
                    'text-overflow': 'ellipsis',
                  }}
                >
                  {task()?.name}
                </span>
                {/* Chevron dropdown button */}
                <button
                  onClick={(e) => handleChevronClick(taskId, e)}
                  style={{
                    display: 'flex',
                    'align-items': 'center',
                    'justify-content': 'center',
                    width: '16px',
                    height: '16px',
                    padding: '0',
                    background: 'transparent',
                    border: 'none',
                    color: 'inherit',
                    cursor: 'pointer',
                    'border-radius': '3px',
                    opacity: '0.6',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.opacity = '1';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.opacity = '0.6';
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z" />
                  </svg>
                </button>
              </div>
            </Show>
          );
        }}
      </For>

      {/* New task button / inline input */}
      <Show
        when={creatingTask()}
        fallback={
          <button
            onClick={openInlineInput}
            style={{
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
              width: '24px',
              height: '24px',
              padding: '0',
              background: 'transparent',
              border: 'none',
              color: 'var(--fg-subtle)',
              cursor: 'pointer',
              'border-radius': '6px',
              'flex-shrink': '0',
              'margin-left': '4px',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.color = 'var(--fg)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.color = 'var(--fg-subtle)';
            }}
            title="New task"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M7.75 2a.75.75 0 01.75.75V7h4.25a.75.75 0 010 1.5H8.5v4.25a.75.75 0 01-1.5 0V8.5H2.75a.75.75 0 010-1.5H7V2.75A.75.75 0 017.75 2z" />
            </svg>
          </button>
        }
      >
        <input
          ref={inputRef}
          value={inputValue()}
          onInput={(e) => setInputValue(e.currentTarget.value)}
          onKeyDown={handleInputKeyDown}
          onBlur={handleInputBlur}
          placeholder="Type prompt and press Enter..."
          style={{
            width: '220px',
            height: '24px',
            padding: '0 8px',
            background: 'var(--bg-input)',
            border: '1px solid var(--border)',
            'border-radius': '6px',
            color: 'var(--fg)',
            'font-size': '12px',
            'font-family': 'var(--font-ui)',
            outline: 'none',
            'flex-shrink': '0',
            'margin-left': '4px',
          }}
        />
      </Show>

      {/* Dropdown menu */}
      <Show
        when={
          dropdownTaskId() && dropdownRect()
            ? {
                taskId: dropdownTaskId() as string,
                rect: dropdownRect() as NonNullable<ReturnType<typeof dropdownRect>>,
              }
            : null
        }
        keyed
      >
        {(ctx) => (
          <TabDropdownMenu
            taskId={ctx.taskId}
            anchorRect={ctx.rect}
            onClose={() => {
              setDropdownTaskId(null);
              setDropdownRect(null);
            }}
          />
        )}
      </Show>
    </div>
  );
}
