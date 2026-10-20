import { renderToString } from 'solid-js/web';
import { describe, expect, it } from 'vitest';
import type { TaskAgentHookStatus } from '../store/agentHookStatus';
import { TaskAgentStatusLine, describeAgentStatus } from './TaskAgentStatusLine';

const NOW = 10_000_000;

function status(overrides: Partial<TaskAgentHookStatus>): TaskAgentHookStatus {
  return {
    agentId: 'a1',
    state: 'working',
    event: 'UserPromptSubmit',
    since: NOW - 3 * 60_000,
    updatedAt: NOW,
    unread: false,
    ...overrides,
  };
}

describe('describeAgentStatus', () => {
  it('names the tool while working and falls back to thinking', () => {
    expect(describeAgentStatus(status({ toolName: 'Bash', detail: 'npm test' }))).toMatchObject({
      label: 'Working',
      text: 'Bash npm test',
    });
    expect(describeAgentStatus(status({})).text).toBe('thinking');
  });

  it('quotes the question or the tool awaiting approval when blocked', () => {
    expect(
      describeAgentStatus(
        status({ state: 'waiting', toolName: 'AskUserQuestion', detail: 'Which DB?' }),
      ),
    ).toMatchObject({ label: 'Needs you', text: 'Which DB?' });
    expect(describeAgentStatus(status({ state: 'waiting', toolName: 'Edit' })).text).toBe(
      'Edit needs approval',
    );
  });

  it('shows the final message once done and marks interrupts', () => {
    expect(
      describeAgentStatus(
        status({ state: 'done', event: 'Stop', lastAssistantMessage: 'Shipped' }),
      ),
    ).toMatchObject({ label: 'Turn finished', text: 'Shipped' });
    expect(describeAgentStatus(status({ state: 'done', event: 'Interrupt' })).label).toBe(
      'Interrupted',
    );
  });

  it('distinguishes session and idle readiness from a finished turn', () => {
    expect(describeAgentStatus(status({ state: 'done', event: 'SessionStart' }))).toMatchObject({
      label: 'Session ready',
      text: '',
    });
    expect(describeAgentStatus(status({ state: 'done', event: 'Notification' }))).toMatchObject({
      label: 'Ready for input',
      text: '',
    });
    expect(
      describeAgentStatus(status({ state: 'done', event: 'StopFailure', detail: 'Agent error' })),
    ).toMatchObject({ label: 'Turn failed', text: 'Agent error' });
  });
});

describe('TaskAgentStatusLine', () => {
  it('renders label, detail, and age as visible text', () => {
    const html = renderToString(() =>
      TaskAgentStatusLine({ status: status({ toolName: 'Read', detail: 'src/a.ts' }), nowMs: NOW }),
    );
    expect(html).toContain('Working');
    expect(html).toContain('src/a.ts');
    expect(html).toContain('3m');
    expect(html).toContain(
      'Agent a1 · Working: src/a.ts · hook report (UserPromptSubmit) · observed just now',
    );
  });

  it('discloses terminal input inference instead of attributing it to hooks', () => {
    const html = renderToString(() =>
      TaskAgentStatusLine({
        status: status({ source: 'terminal', event: 'PermissionAnswered' }),
        nowMs: NOW,
      }),
    );
    expect(html).toContain('Activity inferred from terminal input (PermissionAnswered)');
    expect(html).not.toContain('hook report');
  });

  it('renders nothing without hook status', () => {
    expect(renderToString(() => TaskAgentStatusLine({ status: null, nowMs: NOW }))).not.toContain(
      'task-agent-status',
    );
  });
});
