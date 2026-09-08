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
    ).toMatchObject({ label: 'Done', text: 'Shipped' });
    expect(describeAgentStatus(status({ state: 'done', event: 'Interrupt' })).label).toBe(
      'Interrupted',
    );
  });

  it('calls a freshly started or resumed session idle rather than done', () => {
    expect(describeAgentStatus(status({ state: 'done', event: 'SessionStart' }))).toMatchObject({
      label: 'Idle',
      text: '',
    });
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
    expect(html).toContain('title="Working: Read src/a.ts (3m)"');
  });

  it('renders nothing without hook status', () => {
    expect(renderToString(() => TaskAgentStatusLine({ status: null, nowMs: NOW }))).not.toContain(
      'task-agent-status',
    );
  });
});
