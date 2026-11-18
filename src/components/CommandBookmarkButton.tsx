import { Show } from 'solid-js';
import { openCanvasBrowserAt, setActiveTask, startRunInTask, stopRunInTask } from '../store/store';
import { runState } from '../store/runs';
import { ensureTaskPortBase } from '../store/task-ports';
import { bookmarkLabel, bookmarkUrl } from '../lib/bookmarks';
import { ExternalLinkIcon, PlayIcon, StopSmallIcon } from './icons';
import { toolbarBtnStyle } from './shell-toolbar-style';
import type { TerminalBookmark } from '../store/types';

/** Starts or stops a command bookmark in one task; the run's terminal offers restart. */
export function toggleBookmarkRun(taskId: string, bookmark: TerminalBookmark): void {
  if (runState(taskId, bookmark.id) === 'running') {
    stopRunInTask(taskId, bookmark.id);
    return;
  }
  setActiveTask(taskId);
  void startRunInTask(taskId, bookmark);
}

/**
 * A command bookmark in a task's shell toolbar: a toggle that runs or stops
 * it, plus an Open button for its link in the task's browser preview.
 */
export function CommandBookmarkButton(props: {
  taskId: string;
  bookmark: TerminalBookmark;
  highlighted: boolean;
  onActivate: () => void;
}) {
  const label = () => bookmarkLabel(props.bookmark);
  const running = () => runState(props.taskId, props.bookmark.id) === 'running';
  const open = () => {
    const url = bookmarkUrl(props.bookmark, ensureTaskPortBase(props.taskId));
    if (url) openCanvasBrowserAt(props.taskId, url);
  };

  return (
    <div style={{ display: 'flex', 'align-items': 'center', gap: '2px', 'flex-shrink': '0' }}>
      <button
        type="button"
        class="shell-toolbar-button"
        tabIndex={-1}
        aria-pressed={running()}
        title={running() ? `Stop ${label()}` : `Run ${props.bookmark.command}`}
        onClick={(e) => {
          e.stopPropagation();
          props.onActivate();
          toggleBookmarkRun(props.taskId, props.bookmark);
        }}
        style={toolbarBtnStyle(props.highlighted || running())}
      >
        {running() ? <StopSmallIcon size={12} /> : <PlayIcon size={12} />}
        <span>{label()}</span>
      </button>
      <Show when={props.bookmark.url}>
        <button
          type="button"
          class="shell-toolbar-button"
          tabIndex={-1}
          aria-label={`Open ${label()} in the browser preview`}
          title={`Open ${label()} in the browser preview`}
          onClick={(e) => {
            e.stopPropagation();
            open();
          }}
          style={toolbarBtnStyle(false, true)}
        >
          <ExternalLinkIcon size={12} />
        </button>
      </Show>
    </div>
  );
}
