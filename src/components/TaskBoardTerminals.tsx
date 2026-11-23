import { For, Show } from 'solid-js';
import { openDocumentWorkspace } from '../documents/store';
import { documentAgentTaskId } from '../documents/task-id';
import { store } from '../store/core';
import { setActiveTask } from '../store/navigation';
import { isDocumentProject, isProjectMissing } from '../store/projects';
import { isAgentIdle } from '../store/taskStatus';
import type { Project, Terminal } from '../store/types';
import { BoardLane } from './board/BoardLane';
import { openBesideBoard } from './board/TaskStatus';
import { DocumentIcon, TerminalIcon } from './icons';
import { holdWorking } from './task-board-hold';

/** Open standalone terminals in sidebar order, matching the board search. */
export function boardTerminals(query: string): Terminal[] {
  const needle = query.trim().toLowerCase();
  return store.taskOrder
    .map((id) => store.terminals[id])
    .filter((terminal): terminal is Terminal => terminal !== undefined)
    .filter((terminal) => !terminal.closingStatus && terminal.name.toLowerCase().includes(needle));
}

/** Document projects that can open, in sidebar order, matching the board search. */
export function boardDocs(query: string): Project[] {
  if (!store.documentWorkspacesEnabled) return [];
  const needle = query.trim().toLowerCase();
  return store.projects.filter(
    (project) =>
      isDocumentProject(project) &&
      !isProjectMissing(project.id) &&
      project.name.toLowerCase().includes(needle),
  );
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

/** Shows the document workspace in the board's side panel, as a terminal card does. */
function openDocBeside(projectId: string): void {
  openBesideBoard(documentAgentTaskId(projectId), () => void openDocumentWorkspace(projectId));
}

/** A document project's card: its name, and whether its workspace is the open one. */
function DocBoardCard(props: { project: Project }) {
  const taskId = () => documentAgentTaskId(props.project.id);
  const shown = () => store.boardPeek && store.activeTaskId === taskId();
  return (
    <li
      class="task-board-card task-board-terminal-card task-board-doc-card"
      classList={{ shown: shown() }}
      data-board-card={taskId()}
      data-board-task-id={taskId()}
    >
      <button
        type="button"
        class="task-board-title"
        aria-current={shown() ? 'true' : undefined}
        title={props.project.name}
        onClick={() => openDocBeside(props.project.id)}
      >
        <span class="task-board-glyph" aria-hidden="true">
          <DocumentIcon size={12} />
        </span>
        <span class="task-board-name">{props.project.name}</span>
      </button>
      <p class="task-board-meta">
        {store.activeDocumentProjectId === props.project.id ? 'Open' : 'Document'}
      </p>
    </li>
  );
}

/** Names the lane by what is open; a search leaves it as is so the title never jumps while typing. */
function laneTitle(hasTerminals: boolean, hasDocs: boolean): string {
  if (hasTerminals && hasDocs) return 'Terminals & docs';
  return hasDocs ? 'Docs' : 'Terminals';
}

/**
 * Standalone terminals and document workspaces, in a lane of their own past
 * the task lanes: neither ever needs you, and printing is too weak a signal
 * to sort a shell by, so they stay out of the lanes that do. Shown while any
 * terminal is open or a document project exists; filtering never hides it.
 */
export function TerminalsLane(props: { terminals: Terminal[]; docs: Project[] }) {
  const title = () => laneTitle(boardTerminals('').length > 0, boardDocs('').length > 0);
  return (
    <Show when={boardTerminals('').length > 0 || boardDocs('').length > 0}>
      <BoardLane
        class="lane-terminals"
        aria-labelledby="task-board-lane-terminals"
        headingId="task-board-lane-terminals"
        title={title()}
        count={props.terminals.length + props.docs.length}
      >
        <For each={props.terminals}>{(terminal) => <TerminalBoardCard terminal={terminal} />}</For>
        <For each={props.docs}>{(project) => <DocBoardCard project={project} />}</For>
      </BoardLane>
    </Show>
  );
}
