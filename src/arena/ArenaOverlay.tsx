import './arena-shared.css';
import './arena-config.css';
import './arena-countdown.css';
import './arena-battle.css';
import './arena-results.css';
import './arena-history.css';
import { ScrambleIcon } from '../components/icons';
import { Show, onMount } from 'solid-js';
import { arenaStore } from './store';
import { loadArenaPresets, loadArenaHistory } from './persistence';
import { ConfigScreen } from './ConfigScreen';
import { CountdownScreen } from './CountdownScreen';
import { BattleScreen } from './BattleScreen';
import { ResultsScreen } from './ResultsScreen';
import { HistoryScreen } from './HistoryScreen';

interface ArenaOverlayProps {
  onClose: () => void;
}

export function ArenaOverlay(props: ArenaOverlayProps) {
  onMount(() => {
    void loadArenaPresets();
    void loadArenaHistory();
  });

  function handleClose() {
    props.onClose();
  }

  return (
    <div class="arena-overlay">
      <div class="arena-header">
        <div class="arena-title">
          <ScrambleIcon size={20} />
          AI Arena
        </div>
        <button class="arena-close-btn" onClick={handleClose}>
          Close
        </button>
      </div>
      <div class="arena-body" classList={{ 'arena-body-battle': arenaStore.phase === 'battle' }}>
        <Show when={arenaStore.phase === 'config'}>
          <ConfigScreen />
        </Show>
        <Show when={arenaStore.phase === 'countdown'}>
          <CountdownScreen />
        </Show>
        <Show when={arenaStore.phase === 'battle'}>
          <BattleScreen />
        </Show>
        <Show when={arenaStore.phase === 'results'}>
          <ResultsScreen />
        </Show>
        <Show when={arenaStore.phase === 'history'}>
          <HistoryScreen />
        </Show>
      </div>
    </div>
  );
}
