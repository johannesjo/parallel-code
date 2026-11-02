import './arena-shared.css';
import './arena-config.css';
import './arena-countdown.css';
import './arena-battle.css';
import './arena-results.css';
import './arena-history.css';
import { Show, onMount } from 'solid-js';
import { ScrambleIcon } from '../components/icons';
import { arenaStore } from './store';
import { loadArenaPresets, loadArenaHistory } from './persistence';
import { ConfigScreen } from './ConfigScreen';
import { CountdownScreen } from './CountdownScreen';
import { BattleScreen } from './BattleScreen';
import { ResultsScreen } from './ResultsScreen';
import { HistoryScreen } from './HistoryScreen';
import { createFocusRestore } from '../lib/focus-restore';
import { createFocusTrap } from '../lib/focus-trap';
import { topDialog } from '../lib/dialog-stack';

interface ArenaOverlayProps {
  onClose: () => void;
}

export function ArenaOverlay(props: ArenaOverlayProps) {
  let overlayRef: HTMLDivElement | undefined;
  // Full-screen, so Tab and screen readers must not wander into the app behind.
  // Dialogs opened over the arena (commit, diff) portal outside it and trap Tab
  // themselves; two live traps would fight and stall Tab on their first control.
  createFocusRestore(() => true);
  createFocusTrap(
    () => topDialog() === null,
    () => overlayRef,
  );

  onMount(() => {
    requestAnimationFrame(() => {
      if (overlayRef && !overlayRef.contains(document.activeElement)) overlayRef.focus();
    });
    void loadArenaPresets();
    void loadArenaHistory();
  });

  function handleClose() {
    props.onClose();
  }

  return (
    <div
      ref={overlayRef}
      class="arena-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="AI Arena"
      tabIndex={-1}
    >
      <div class="arena-header">
        <div class="arena-title">
          <ScrambleIcon size={20} />
          AI Arena
        </div>
        <button type="button" class="arena-close-btn" onClick={handleClose}>
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
