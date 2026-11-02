import { For, Show } from 'solid-js';
import { store } from '../store/core';
import { setActiveTask } from '../store/navigation';
import { isAgentIdle } from '../store/taskStatus';
import type { Terminal } from '../store/types';
import { BoardLane } from './board/BoardLane';
import { openBesideBoard } from './board/TaskStatus';
import { TerminalIcon } from './icons';
import { holdWorking } from './task-board-hold';

/** Open standalone terminals in sidebar order, matching the board search. */
export function boardTerminals(query: string): Terminal[] {
  const needle = query.trim().toLowerCase();
  return store.taskOrder
    .map((id) => store.terminals[id])
    .filter((terminal): terminal is Terminal => terminal !== undefined)
    .filter((terminal) => !terminal.closingStatus && terminal.name.toLowerCase().includes(needle));
}

/** Whether the terminal printed lately, smoothed over short pauses like a task. */
function isRunning(terminal: Terminal): boolean {
  const state = isAgentIdle(terminal.agentId) ? 'idle' : 'active';
  return holdWorking(terminal.id, state) === 'active';
}

/** Shows the terminal in the board's side panel, as a task card does. */
function openTerminalBeside(terminalId: string): void {
  openBesideBoard(terminalId, () => setActiveTask(terminalId));
}

/** A plain terminal's card: lighter than a task's, with only its name and state. */
function TerminalBoardCard(props: { terminal: Terminal }) {
  const shown = () => store.boardPeek && store.activeTaskId === props.terminal.id;
  return (
    <li
      class="task-board-card task-board-terminal-card"
      classList={{ shown: shown() }}
      data-board-card={props.terminal.id}
      data-board-task-id={props.terminal.id}
    >
      <button
        type="button"
        class="task-board-title"
        aria-current={shown() ? 'true' : undefined}
        title={props.terminal.name}
        onClick={() => openTerminalBeside(props.terminal.id)}
      >
        <span class="task-board-glyph" aria-hidden="true">
          <TerminalIcon size={12} />
        </span>
        <span class="task-board-name">{props.terminal.name}</span>
      </button>
      <p class="task-board-meta">{isRunning(props.terminal) ? 'Running' : 'Idle'}</p>
    </li>
  );
}

/**
 * Standalone terminals, in a lane of their own past the task lanes: a shell
 * never needs you, and printing is too weak a signal to sort it by, so it
 * stays out of the lanes that do. Shown while any terminal is open.
 */
export function TerminalsLane(props: { terminals: Terminal[] }) {
  return (
    <Show when={boardTerminals('').length > 0}>
      <BoardLane
        class="lane-terminals"
        aria-labelledby="task-board-lane-terminals"
        headingId="task-board-lane-terminals"
        title="Terminals"
        count={props.terminals.length}
      >
        <For each={props.terminals}>{(terminal) => <TerminalBoardCard terminal={terminal} />}</For>
      </BoardLane>
    </Show>
  );
}
