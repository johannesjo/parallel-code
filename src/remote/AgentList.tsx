import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import { agents, status, canControl } from './ws';
import { agentStatusDisplay, isCiFailed } from './attention';
import { ConnectionBanner } from './ConnectionBanner';
import { TaskPr } from './TaskPr';
import { NotificationSettings } from './NotificationSettings';
import { readLocal, writeLocal } from './storage';
import { ProjectSwatch } from '../components/ProjectSwatch';
import { sanitizeProjectIcon } from '../lib/project-icon';
import type { RemoteAgent, RemoteBoardLane } from '../../electron/remote/protocol';

const ANDROID_APP_GUIDE = 'https://github.com/johannesjo/parallel-code#android-app';

interface AgentListProps {
  onSelect: (taskId: string) => void;
  onNewTask: () => void;
  onPair: () => void;
}

// The desktop board's lanes, top to bottom in its left-to-right order, so a
// task sits under the same heading on both screens.
const lanes: { id: RemoteBoardLane; name: string }[] = [
  { id: 'needs', name: 'Needs you' },
  { id: 'stopped', name: 'Stopped' },
  { id: 'working', name: 'Working' },
  { id: 'pr', name: 'In pull request' },
  { id: 'ready', name: 'Ready to merge' },
  { id: 'snoozed', name: 'Snoozed & minimized' },
];

/** The desktop sends each task's lane; this only covers a task it has not described yet. */
function laneOf(agent: RemoteAgent): RemoteBoardLane {
  if (agent.lane) return agent.lane;
  if (['needs_input', 'error', 'review'].includes(agent.attention)) return 'needs';
  if (agent.collapsed) return 'snoozed';
  return agent.attention === 'active' ? 'working' : 'stopped';
}

/** The desktop's lane decides, so failed CI that Babysit hands to the agent is
 *  not counted; a task it has not described yet falls back to its CI. */
const needsAttention = (agent: RemoteAgent) =>
  laneOf(agent) === 'needs' || (!agent.lane && isCiFailed(agent));

export function AgentList(props: AgentListProps) {
  let searchInput: HTMLInputElement | undefined;
  const [search, setSearch] = createSignal(readLocal('task-search'));
  const savedFilter = readLocal('task-filter');
  const [filter, setFilter] = createSignal(
    savedFilter === 'needs' || savedFilter === 'stopped' ? savedFilter : 'all',
  );
  createEffect(() => writeLocal('task-search', search()));
  createEffect(() => writeLocal('task-filter', filter()));
  const needsYou = createMemo(() => agents().filter(needsAttention).length);
  const matchingSearch = createMemo(() => {
    const query = search().trim().toLocaleLowerCase();
    return agents().filter((a) =>
      `${a.taskName} ${a.projectName ?? ''} ${a.agentName ?? ''}`
        .toLocaleLowerCase()
        .includes(query),
    );
  });
  const matchesFilter = (agent: RemoteAgent, id: string) =>
    id === 'all' || (id === 'needs' ? needsAttention(agent) : laneOf(agent) === id);
  const filtered = createMemo(() => matchingSearch().filter((a) => matchesFilter(a, filter())));
  function clearFilters() {
    setSearch('');
    setFilter('all');
  }

  return (
    <div class="mobile-screen">
      <header class="mobile-header">
        <div class="heading">
          <p class="mobile-eyebrow">Parallel Code</p>
          <h1>Your tasks</h1>
          <p>
            {needsYou()
              ? `${needsYou()} ${needsYou() === 1 ? 'task needs' : 'tasks need'} your attention`
              : 'Keep work moving from here'}
          </p>
        </div>
      </header>
      <ConnectionBanner />
      <Show when={status() === 'connected' && !canControl()}>
        <div class="mobile-banner info">
          <span>View only · authorize this phone to reply.</span>
          <button class="mobile-button quiet" onClick={() => props.onPair()}>
            Enable replies
          </button>
        </div>
      </Show>
      <main class="mobile-scroll">
        <Show when={canControl()}>
          <NotificationSettings />
        </Show>
        <Show when={/Android/i.test(navigator.userAgent)}>
          <details class="mobile-notifications">
            <summary>Android app</summary>
            <p>
              The Android app notifies you in the background without HTTPS and adds a home-screen
              widget.{' '}
              <a href={ANDROID_APP_GUIDE} target="_blank" rel="noreferrer">
                Install it
              </a>
              , then scan the same QR code.
            </p>
          </details>
        </Show>
        <Show when={agents().length > 0}>
          <div class="mobile-search-field">
            <input
              ref={searchInput}
              class="mobile-search"
              type="search"
              aria-label="Search tasks, projects, or agents"
              placeholder="Find a task, project, or agent…"
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
            />
            <Show when={search()}>
              <button
                class="mobile-button quiet"
                aria-label="Clear search"
                onClick={() => {
                  setSearch('');
                  searchInput?.focus();
                }}
              >
                ×
              </button>
            </Show>
          </div>
          <div class="mobile-filters" role="group" aria-label="Filter tasks">
            <For
              each={[
                { id: 'all', label: 'All' },
                { id: 'needs', label: 'Needs you' },
                { id: 'stopped', label: 'Stopped' },
              ]}
            >
              {(item) => (
                <button
                  class="mobile-filter"
                  aria-pressed={filter() === item.id}
                  onClick={() => setFilter(item.id)}
                >
                  {item.label}{' '}
                  <span>{matchingSearch().filter((a) => matchesFilter(a, item.id)).length}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={agents().length === 0}>
          <div class="mobile-empty">
            <h2>
              {status() === 'connected' ? 'Start something new' : 'Waiting for your computer'}
            </h2>
            <p>
              {status() === 'connected'
                ? 'No agents are running. Give an agent a task and follow its progress here.'
                : 'Keep Parallel Code open on your computer and check that both devices can reach each other.'}
            </p>
          </div>
        </Show>
        <Show when={agents().length > 0 && filtered().length === 0}>
          <div class="mobile-empty" role="status">
            <h2>
              {search()
                ? 'No matching tasks'
                : filter() === 'needs'
                  ? 'Nothing needs you right now'
                  : 'No stopped tasks'}
            </h2>
            <p>
              {search()
                ? `Try a different name or clear your filters for “${search()}”.`
                : 'You can check the other tasks while your agents work.'}
            </p>
            <button class="mobile-button" onClick={clearFilters}>
              Show all tasks
            </button>
          </div>
        </Show>
        <For each={lanes}>
          {(group) => {
            const items = () => filtered().filter((a) => laneOf(a) === group.id);
            return (
              <Show when={items().length > 0}>
                <section class="mobile-group" aria-label={group.name}>
                  <h2>
                    {group.name} <span>{items().length}</span>
                  </h2>
                  <For each={items()}>
                    {(agent: RemoteAgent) => {
                      // The PR row already spells out what the checks say, so the status does not repeat it.
                      const display = () =>
                        agentStatusDisplay(agent.pr?.label ? { ...agent, ci: undefined } : agent);
                      return (
                        <button
                          class="agent-card"
                          classList={{ attention: needsAttention(agent) }}
                          onClick={() => props.onSelect(agent.taskId)}
                        >
                          <strong title={agent.taskName}>{agent.taskName}</strong>
                          <div class="agent-card-meta">
                            <p class="muted">
                              <Show when={agent.projectColor}>
                                {(color) => (
                                  <ProjectSwatch
                                    color={color()}
                                    icon={sanitizeProjectIcon(agent.projectIcon)}
                                    size={10}
                                  />
                                )}
                              </Show>
                              {[agent.projectName, agent.agentName].filter(Boolean).join(' · ') ||
                                'Agent task'}
                            </p>
                            <span class="agent-status" style={{ color: display().color }}>
                              <span class="status-dot" aria-hidden="true" />
                              {display().label}
                            </span>
                          </div>
                          <Show when={agent.lastLine}>
                            <p class="agent-preview" title="Recent terminal output">
                              {agent.lastLine}
                            </p>
                          </Show>
                          <Show when={agent.pr}>{(pr) => <TaskPr pr={pr()} />}</Show>
                        </button>
                      );
                    }}
                  </For>
                </section>
              </Show>
            );
          }}
        </For>
      </main>
      <footer class="mobile-footer">
        <button
          class="mobile-button primary wide"
          onClick={() => props.onNewTask()}
          disabled={status() !== 'connected'}
        >
          + New task
        </button>
      </footer>
    </div>
  );
}
