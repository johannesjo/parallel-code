import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import { agents, status, canControl } from './ws';
import { agentStatusDisplay } from './attention';
import { ConnectionBanner } from './ConnectionBanner';
import { UsageStrip } from './UsageStrip';
import { readLocal, writeLocal } from './storage';
import { ProjectSwatch } from '../components/ProjectSwatch';
import type { RemoteAgent } from '../../electron/remote/protocol';

interface AgentListProps {
  onSelect: (taskId: string) => void;
  onNewTask: () => void;
  onPair: () => void;
}

const groups = [
  { name: 'Needs you', states: ['needs_input', 'error'] },
  { name: 'Working', states: ['active'] },
  { name: 'Ready to review', states: ['review', 'ready'] },
  { name: 'Other tasks', states: ['idle', 'shell_busy'] },
];

export function AgentList(props: AgentListProps) {
  let searchInput: HTMLInputElement | undefined;
  const [search, setSearch] = createSignal(readLocal('task-search'));
  const savedFilter = readLocal('task-filter');
  const [filter, setFilter] = createSignal(
    savedFilter === 'attention' || savedFilter === 'review' ? savedFilter : 'all',
  );
  createEffect(() => writeLocal('task-search', search()));
  createEffect(() => writeLocal('task-filter', filter()));
  const needsYou = createMemo(
    () => agents().filter((a) => a.attention === 'needs_input' || a.attention === 'error').length,
  );
  const matchingSearch = createMemo(() => {
    const query = search().trim().toLocaleLowerCase();
    return agents().filter((a) =>
      `${a.taskName} ${a.projectName ?? ''} ${a.agentName ?? ''}`
        .toLocaleLowerCase()
        .includes(query),
    );
  });
  const matchesFilter = (agent: RemoteAgent, id: string) =>
    id === 'all' ||
    (id === 'attention' && ['needs_input', 'error'].includes(agent.attention)) ||
    (id === 'review' && ['review', 'ready'].includes(agent.attention));
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
        <UsageStrip />
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
                { id: 'attention', label: 'Needs you' },
                { id: 'review', label: 'Review' },
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
                : filter() === 'attention'
                  ? 'Nothing needs you right now'
                  : 'Nothing to review yet'}
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
        <For each={groups}>
          {(group) => {
            const items = () => filtered().filter((a) => group.states.includes(a.attention));
            return (
              <Show when={items().length > 0}>
                <section class="mobile-group" aria-label={group.name}>
                  <h2>
                    {group.name} <span>{items().length}</span>
                  </h2>
                  <For each={items()}>
                    {(agent: RemoteAgent) => {
                      const display = () => agentStatusDisplay(agent);
                      return (
                        <button
                          class="agent-card"
                          classList={{ attention: group.name === 'Needs you' }}
                          onClick={() => props.onSelect(agent.taskId)}
                        >
                          <div class="agent-card-top">
                            <strong title={agent.taskName}>{agent.taskName}</strong>
                            <span class="agent-card-chevron" aria-hidden="true">
                              ›
                            </span>
                          </div>
                          <div class="agent-card-meta">
                            <p class="muted">
                              <Show when={agent.projectColor}>
                                {(color) => <ProjectSwatch color={color()} size={10} />}
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
