import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { SessionPicker, relativeTime } from './SessionPicker';
import { listResumableSessions, resumeAgentSession } from '../store/sessions';
import type { SessionRecord } from '../../electron/shared/session-record';

vi.mock('../store/sessions', () => ({
  listResumableSessions: vi.fn(async () => []),
  resumeAgentSession: vi.fn(),
}));

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'fb4f2bc6-62d9-4b29-a795-240caf2fc459',
    agent: 'claude',
    cwd: '/w/alpha',
    updatedAt: Date.now(),
    ...overrides,
  };
}

let dispose: (() => void) | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listResumableSessions).mockResolvedValue([]);
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  host.remove();
});

function mount(props: Partial<Parameters<typeof SessionPicker>[0]> = {}) {
  dispose = render(
    () => <SessionPicker taskId="t1" agentId="a1" command="claude" {...props} />,
    host,
  );
}

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === label || b.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

/** A session row carries its title plus an age/branch line, so it is matched on
 *  containment rather than an exact label. */
function sessionRow(title: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(title));
  if (!found) throw new Error(`Missing session row: ${title}`);
  return found;
}

const openPicker = async () => {
  button('Resume a specific session').click();
  await Promise.resolve();
  await Promise.resolve();
};

describe('SessionPicker', () => {
  it('renders nothing for a CLI that cannot resume a named session', () => {
    mount({ command: 'gemini' });
    expect(host.querySelector('button')).toBeNull();
  });

  it.each(['claude', 'codex'])('offers the picker for %s', (command) => {
    mount({ command });
    expect(host.querySelector('button')).not.toBeNull();
  });

  // Nothing is read until asked for: the scan touches the filesystem.
  it('does not fetch until opened', async () => {
    mount();
    expect(listResumableSessions).not.toHaveBeenCalled();
    await openPicker();
    expect(listResumableSessions).toHaveBeenCalledWith('t1', 'claude');
  });

  it('lists a session by its title', async () => {
    vi.mocked(listResumableSessions).mockResolvedValue([session({ title: 'Fix the parser' })]);
    mount();
    await openPicker();
    expect(host.textContent).toContain('Fix the parser');
  });

  it('falls back to a short id when a session has no title', async () => {
    vi.mocked(listResumableSessions).mockResolvedValue([session()]);
    mount();
    await openPicker();
    expect(host.textContent).toContain('Session fb4f2bc6');
  });

  it('says so when the worktree has no recorded sessions', async () => {
    mount();
    await openPicker();
    expect(host.textContent).toContain('No recorded sessions for this worktree');
  });

  it('shows the branch a session ran on', async () => {
    vi.mocked(listResumableSessions).mockResolvedValue([
      session({ title: 'Fix it', branch: 'task/alpha' }),
    ]);
    mount();
    await openPicker();
    expect(host.textContent).toContain('task/alpha');
  });

  it('resumes the session that was clicked', async () => {
    const target = session({ id: 'aaaa1111-0000-4000-8000-000000000000', title: 'Pick me' });
    vi.mocked(listResumableSessions).mockResolvedValue([target]);
    mount();
    await openPicker();
    sessionRow('Pick me').click();
    expect(resumeAgentSession).toHaveBeenCalledWith('t1', 'a1', target.id);
  });

  it('marks the session the pane is already pointed at', async () => {
    const current = session({ title: 'Current one' });
    vi.mocked(listResumableSessions).mockResolvedValue([current]);
    mount({ currentSessionId: current.id });
    await openPicker();
    expect(host.textContent).toContain('current');
  });

  it('closes after a pick', async () => {
    vi.mocked(listResumableSessions).mockResolvedValue([session({ title: 'Pick me' })]);
    mount();
    await openPicker();
    sessionRow('Pick me').click();
    await Promise.resolve();
    expect(host.textContent).not.toContain('Pick me');
  });

  it('closes on a click outside', async () => {
    vi.mocked(listResumableSessions).mockResolvedValue([session({ title: 'Pick me' })]);
    mount();
    await openPicker();
    expect(host.textContent).toContain('Pick me');
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await Promise.resolve();
    expect(host.textContent).not.toContain('Pick me');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-09-17T12:00:00Z');
  // The assertions match English wording.
  const ago = (iso: string) => relativeTime(Date.parse(iso), now, 'en');

  it('picks the largest fitting unit', () => {
    expect(ago('2026-09-15T12:00:00Z')).toMatch(/day/);
    expect(ago('2026-09-17T09:00:00Z')).toMatch(/hour/);
    expect(ago('2026-09-17T11:30:00Z')).toMatch(/minute/);
  });

  it('falls through to seconds for a very recent session', () => {
    expect(ago('2026-09-17T11:59:50Z')).toMatch(/second/);
  });
});
