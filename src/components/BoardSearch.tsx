import { createSignal } from 'solid-js';
import { store } from '../store/core';
import { SearchIcon } from './icons';
import { claimBoardFocus, focusBoardCard, releaseBoardFocus } from './task-board-keys';
import './task-board.css';

// One query for both boards, so it survives switching between running tasks and the plan.
const [boardQuery, setBoardQuery] = createSignal('');
export { boardQuery, setBoardQuery };

/**
 * The text filter in the board's title-bar controls, an icon button until used.
 * `what` names what it searches: running tasks or the plan's cards.
 */
export function BoardSearch(props: { what: string }) {
  return (
    // In the title bar, outside the board, yet the board's keys still lead here and back.
    <span class="task-board-search-box" onFocusIn={claimBoardFocus} onFocusOut={releaseBoardFocus}>
      <SearchIcon size={14} />
      <input
        type="search"
        class="task-board-search"
        placeholder={`Filter ${props.what}`}
        aria-label={`Filter ${props.what}`}
        aria-keyshortcuts="/"
        // Folded, the button hides the query, so its tooltip names it.
        title={
          boardQuery()
            ? `Filtering ${props.what} by “${boardQuery()}” (/)`
            : `Filter ${props.what} (/). Down goes to the cards, Enter opens the first.`
        }
        value={boardQuery()}
        onInput={(e) => setBoardQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // A second Escape returns to the cards rather than closing the board.
            e.stopPropagation();
            if (boardQuery()) setBoardQuery('');
            else focusBoardCard(store.activeTaskId);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            focusBoardCard(null);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            document
              .querySelector<HTMLElement>('.task-board-lane:not(.lane-ideas) .task-board-title')
              ?.click();
          }
        }}
      />
    </span>
  );
}
