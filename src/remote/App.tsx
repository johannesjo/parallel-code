import { createSignal, onMount, Show, Switch, Match } from 'solid-js';
import { initAuth, getPairedToken } from './auth';
import { connect, reconnect } from './ws';
import { AgentList } from './AgentList';
import { AgentDetail } from './AgentDetail';
import { ConnectScreen } from './ConnectScreen';
import { PairScreen } from './PairScreen';
import { NewTaskScreen } from './NewTaskScreen';

type View = 'list' | 'detail' | 'pair' | 'newtask';

export function App() {
  const [authed, setAuthed] = createSignal(false);
  // Separate view state from detail data so the agentId/taskName signals
  // never become empty while AgentDetail is still mounted (avoids reactive
  // race where Show disposes children *after* props re-evaluate to null).
  const [view, setView] = createSignal<View>('list');
  const [detailAgentId, setDetailAgentId] = createSignal('');
  const [detailTaskName, setDetailTaskName] = createSignal('');
  // Where to land after pairing: the New Task form, or back to the agent the
  // user was about to type into.
  const [afterPairing, setAfterPairing] = createSignal<View>('newtask');

  function selectAgent(id: string, name: string) {
    setDetailAgentId(id);
    setDetailTaskName(name);
    setView('detail');
  }

  // Creating a task needs the elevated paired token; pair first if we don't
  // have one yet.
  function startNewTask() {
    setAfterPairing('newtask');
    setView(getPairedToken() ? 'newtask' : 'pair');
  }

  // Typing into a terminal (or saving notes) needs the paired token too. The
  // socket reconnects with it after pairing (see ws.ts), so returning to the
  // detail view is enough.
  function pairForDetail() {
    setAfterPairing('detail');
    setView('pair');
  }

  // A fresh paired token must also reach the socket, which authenticated with
  // whichever token it had at connect time.
  function onPaired() {
    reconnect();
    setView(afterPairing());
  }

  function onConnected() {
    setAuthed(true);
    connect();
  }

  onMount(() => {
    const token = initAuth();
    if (token) onConnected();
  });

  return (
    <Show when={authed()} fallback={<ConnectScreen onConnected={onConnected} />}>
      <Switch fallback={<AgentList onSelect={selectAgent} onNewTask={startNewTask} />}>
        <Match when={view() === 'detail'}>
          <AgentDetail
            agentId={detailAgentId()}
            taskName={detailTaskName()}
            onBack={() => setView('list')}
            onNeedsPairing={pairForDetail}
          />
        </Match>
        <Match when={view() === 'pair'}>
          <PairScreen
            onPaired={onPaired}
            onCancel={() => setView(afterPairing() === 'detail' ? 'detail' : 'list')}
          />
        </Match>
        <Match when={view() === 'newtask'}>
          <NewTaskScreen
            onCreated={() => setView('list')}
            onCancel={() => setView('list')}
            onNeedsPairing={() => {
              setAfterPairing('newtask');
              setView('pair');
            }}
          />
        </Match>
      </Switch>
    </Show>
  );
}
