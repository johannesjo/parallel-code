import { For, Show, createMemo } from 'solid-js';
import { agents, status } from './ws';
import { agentStatusDisplay } from './attention';
import type { RemoteAgent } from '../../electron/remote/protocol';

interface AgentListProps {
  onSelect: (agentId: string, taskName: string) => void;
  onNewTask: () => void;
}

export function AgentList(props: AgentListProps) {
  const running = createMemo(() => agents().filter((a) => a.status === 'running').length);
  const total = createMemo(() => agents().length);
  const needsInput = createMemo(() => agents().filter((a) => a.attention === 'needs_input').length);

  // Surface tasks that want attention at the top; keep original order within a
  // rank so the list doesn't jump around on unrelated status changes.
  const ATTENTION_RANK: Record<string, number> = {
    needs_input: 0,
    error: 1,
    review: 2,
    active: 3,
    ready: 4,
    idle: 5,
  };
  const sortedAgents = createMemo(() =>
    agents()
      .map((a, i) => ({ a, i }))
      .sort((x, y) => {
        const rx = ATTENTION_RANK[x.a.attention] ?? 5;
        const ry = ATTENTION_RANK[y.a.attention] ?? 5;
        return rx - ry || x.i - y.i;
      })
      .map((e) => e.a),
  );

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100%',
        background: '#0b0f14',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          padding: '14px 16px 12px',
          'border-bottom': '1px solid #223040',
          background: '#12181f',
        }}
      >
        <span style={{ 'font-size': '18px', 'font-weight': '600', color: '#d7e4f0' }}>
          Parallel Code
        </span>
        <div style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
          <Show when={needsInput() > 0}>
            <span
              style={{
                display: 'inline-flex',
                'align-items': 'center',
                gap: '5px',
                padding: '3px 9px',
                'border-radius': '999px',
                background: '#3a2a0d',
                color: '#ffc569',
                'font-size': '12px',
                'font-weight': '600',
              }}
            >
              <span
                style={{
                  width: '7px',
                  height: '7px',
                  'border-radius': '50%',
                  background: '#ffc569',
                }}
              />
              {needsInput()} needs input
            </span>
          </Show>
          <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
            <div
              style={{
                width: '8px',
                height: '8px',
                'border-radius': '50%',
                background:
                  status() === 'connected'
                    ? '#2fd198'
                    : status() === 'connecting'
                      ? '#ffc569'
                      : '#ff5f73',
              }}
            />
            <span style={{ 'font-size': '14px', color: '#678197' }}>
              {running()}/{total()}
            </span>
          </div>
          <button
            onClick={() => props.onNewTask()}
            aria-label="New task"
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '4px',
              padding: '6px 12px',
              background: '#173042',
              border: '1px solid #2ec8ff55',
              'border-radius': '8px',
              color: '#2ec8ff',
              'font-size': '14px',
              'font-weight': '600',
              cursor: 'pointer',
              'touch-action': 'manipulation',
            }}
          >
            + New
          </button>
        </div>
      </div>

      {/* Connection status banner */}
      <Show when={status() !== 'connected'}>
        <div
          style={{
            padding: '8px 16px',
            background: status() === 'connecting' ? '#78350f' : '#7f1d1d',
            color: status() === 'connecting' ? '#fde68a' : '#fca5a5',
            'font-size': '14px',
            'text-align': 'center',
            'flex-shrink': '0',
          }}
        >
          {status() === 'connecting' ? 'Reconnecting...' : 'Disconnected — check your network'}
        </div>
      </Show>

      {/* Agent cards */}
      <div
        style={{
          flex: '1',
          overflow: 'auto',
          padding: '12px',
          display: 'flex',
          'flex-direction': 'column',
          gap: '8px',
          '-webkit-overflow-scrolling': 'touch',
          'padding-bottom': 'max(12px, env(safe-area-inset-bottom))',
        }}
      >
        <Show when={agents().length === 0}>
          <div
            style={{
              'text-align': 'center',
              color: '#678197',
              'padding-top': '60px',
              'font-size': '15px',
            }}
          >
            <Show when={status() === 'connected'} fallback={<span>Connecting...</span>}>
              <span>No active agents</span>
            </Show>
          </div>
        </Show>

        {/* Experimental notice */}
        <div
          style={{
            padding: '8px 12px',
            background: '#11182080',
            border: '1px solid #223040',
            'border-radius': '12px',
            'font-size': '13px',
            color: '#9bb0c3',
            'text-align': 'center',
            'line-height': '1.5',
          }}
        >
          This is an experimental feature.{' '}
          <a
            href="https://github.com/johannesjo/parallel-code/issues"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#2ec8ff' }}
          >
            Report bugs
          </a>
        </div>

        <For each={sortedAgents()}>
          {(agent: RemoteAgent) => {
            const display = () => agentStatusDisplay(agent);
            return (
              <div
                onClick={() => props.onSelect(agent.agentId, agent.taskName)}
                style={{
                  background: '#0f141b',
                  border: display().glow ? `1px solid ${display().color}66` : '1px solid #223040',
                  'border-radius': '12px',
                  padding: '14px 16px',
                  cursor: 'pointer',
                  display: 'flex',
                  'flex-direction': 'column',
                  gap: '6px',
                  'touch-action': 'manipulation',
                  transition: 'background 0.16s ease',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    'align-items': 'center',
                    'justify-content': 'space-between',
                    gap: '8px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      'align-items': 'center',
                      gap: '8px',
                      'min-width': '0',
                      flex: '1',
                    }}
                  >
                    <div
                      style={{
                        width: '8px',
                        height: '8px',
                        'border-radius': '50%',
                        background: display().color,
                        'box-shadow': display().glow ? `0 0 0 3px ${display().color}33` : 'none',
                        'flex-shrink': '0',
                      }}
                    />
                    <span
                      style={{
                        'font-size': '15px',
                        'font-weight': '500',
                        color: '#d7e4f0',
                        overflow: 'hidden',
                        'text-overflow': 'ellipsis',
                        'white-space': 'nowrap',
                      }}
                    >
                      {agent.taskName}
                    </span>
                  </div>
                  <span
                    style={{
                      'font-size': '13px',
                      'font-weight': display().glow ? '600' : '400',
                      color: display().color,
                      'flex-shrink': '0',
                    }}
                  >
                    {display().label}
                  </span>
                </div>

                <div
                  style={{
                    'font-size': '12px',
                    'font-family': "'JetBrains Mono', 'Courier New', monospace",
                    color: '#678197',
                    'white-space': 'nowrap',
                    overflow: 'hidden',
                    'text-overflow': 'ellipsis',
                  }}
                >
                  {agent.agentId}
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
