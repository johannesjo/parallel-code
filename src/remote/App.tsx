import { createSignal, onMount, Show } from 'solid-js';
import { initAuth } from './auth';
import { connect } from './ws';
import { AgentList } from './AgentList';
import { AgentDetail } from './AgentDetail';

export function App() {
  const [authed, setAuthed] = createSignal(false);
  // Separate view state from detail data so the agentId/taskName signals
  // never become empty while AgentDetail is still mounted (avoids reactive
  // race where Show disposes children *after* props re-evaluate to null).
  const [view, setView] = createSignal<'list' | 'detail'>('list');
  const [detailAgentId, setDetailAgentId] = createSignal('');
  const [detailTaskName, setDetailTaskName] = createSignal('');

  function selectAgent(id: string, name: string) {
    setDetailAgentId(id);
    setDetailTaskName(name);
    setView('detail');
  }

  onMount(() => {
    const token = initAuth();
    if (token) {
      setAuthed(true);
      connect();
    }
  });

  return (
    <Show
      when={authed()}
      fallback={
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            height: '100%',
            color: '#999',
            'font-size': '17px',
            padding: '20px',
            'text-align': 'center',
          }}
        >
          <div>
            <p style={{ 'margin-bottom': '12px' }}>Not authenticated.</p>
            <p style={{ 'font-size': '14px', color: '#666' }}>
              Scan the QR code from the Parallel Code desktop app to connect.
            </p>
          </div>
        </div>
      }
    >
      <Show when={view() === 'detail'} fallback={<AgentList onSelect={selectAgent} />}>
        <AgentDetail
          agentId={detailAgentId()}
          taskName={detailTaskName()}
          onBack={() => setView('list')}
        />
      </Show>
    </Show>
  );
}
