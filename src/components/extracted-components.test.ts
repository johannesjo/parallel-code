import { renderToString } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { presetsForTone } from '../lib/look';
import { setStore } from '../store/core';
import { CheckboxOption, InlineBanner } from './NewTaskDialog';
import { PresetThemeCard, SettingsCheckboxRow } from './SettingsDialog';
import { TaskRowShell } from './Sidebar';

function renderRowShell(taskId: string): string {
  return renderToString(() =>
    TaskRowShell({
      taskId,
      class: 'task-item',
      onClick: vi.fn(),
      fontSize: '13px',
      cursor: 'pointer',
      opacity: '1',
      children: 'Task Alpha',
    }),
  );
}

describe('extracted component helpers', () => {
  afterEach(() => {
    setStore('activeTaskId', null);
    setStore('tasks', {});
  });

  it('renders settings checkbox rows with label, description, and checked state', () => {
    const html = renderToString(() =>
      SettingsCheckboxRow({
        label: 'Show plans',
        description: 'Keep task plans visible',
        checked: true,
        onChange: vi.fn(),
      }),
    );

    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked');
    expect(html).toContain('Show plans');
    expect(html).toContain('Keep task plans visible');
  });

  it('renders active preset theme cards with clone affordance', () => {
    const preset = presetsForTone('light')[0];
    const html = renderToString(() =>
      PresetThemeCard({
        preset,
        active: true,
        onSelect: vi.fn(),
        onClone: vi.fn(),
      }),
    );

    expect(html).toContain('settings-theme-card active');
    expect(html).toContain(preset.label);
    expect(html).toContain(preset.description);
    expect(html).toContain('title="Clone as custom theme"');
  });

  it('renders new-task checkbox options with disabled state and title', () => {
    const html = renderToString(() =>
      CheckboxOption({
        label: 'Run in Docker container',
        checked: false,
        disabled: true,
        title: 'Docker unavailable',
        onChange: vi.fn(),
      }),
    );

    expect(html).toContain('title="Docker unavailable"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('disabled');
    expect(html).toContain('Run in Docker container');
  });

  it('renders inline banners with custom text and sizing', () => {
    const html = renderToString(() =>
      InlineBanner({
        color: '#f59e0b',
        fontSize: '12px',
        children: 'Coordinator Docker warning',
      }),
    );

    expect(html).toContain('Coordinator Docker warning');
    expect(html).toContain('font-size:12px');
  });

  it('renders task row shell navigation metadata and children', () => {
    const html = renderToString(() =>
      TaskRowShell({
        taskId: 'task-1',
        class: 'task-item',
        taskIndex: 2,
        sidebarTaskId: 'task-1',
        role: 'button',
        tabIndex: 0,
        title: 'Open task',
        onClick: vi.fn(),
        fontSize: '13px',
        cursor: 'pointer',
        opacity: '1',
        children: 'Task Alpha',
      }),
    );

    expect(html).toContain('class="task-item"');
    expect(html).toContain('role="button"');
    expect(html).toContain('data-task-index="2"');
    expect(html).toContain('data-sidebar-task-id="task-1"');
    expect(html).toContain('data-attention="idle"');
    expect(html).not.toContain('aria-current');
    expect(html).toContain('Task Alpha');
  });

  it('marks the task row shell of the active task as current', () => {
    setStore('activeTaskId', 'task-1');

    expect(renderRowShell('task-1')).toContain('aria-current="true"');
  });

  it('exposes the attention state that keeps a row\u2019s status detail visible', () => {
    setStore('tasks', 'task-1', {
      id: 'task-1',
      name: 'Task Alpha',
      projectId: 'project-1',
      branchName: 'task/alpha',
      worktreePath: '/tmp/alpha',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
      gitIsolation: 'worktree',
      needsReview: true,
    });

    expect(renderRowShell('task-1')).toContain('data-attention="review"');
  });
});
