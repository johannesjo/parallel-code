import { For, Show } from 'solid-js';
import {
  getProject,
  openCanvasBrowserAt,
  setActiveTask,
  startRunInTask,
  stopRunInTask,
} from '../store/store';
import { runState } from '../store/runs';
import { ensureTaskPortBase } from '../store/task-ports';
import { runCommandUrl } from '../lib/run-commands';
import { ExternalLinkIcon, PlayIcon, RefreshIcon, StopSmallIcon } from './icons';
import { toolbarBtnStyle } from './shell-toolbar-style';
import type { RunCommand, Task } from '../store/types';

/**
 * The project's run commands for one task: start or stop each server,
 * restart it, and open its address in the task's browser preview. Renders
 * nothing for a project without run commands.
 */
export function TaskRunButtons(props: { task: Task }) {
  const runs = () => getProject(props.task.projectId)?.runCommands ?? [];

  return (
    <Show when={runs().length > 0}>
      <div
        role="group"
        aria-label="Run commands"
        style={{ display: 'flex', 'align-items': 'center', gap: '4px', 'flex-shrink': '0' }}
      >
        <For each={runs()}>{(run) => <RunButtons task={props.task} run={run} />}</For>
      </div>
    </Show>
  );
}

function RunButtons(props: { task: Task; run: RunCommand }) {
  const running = () => runState(props.task.id, props.run.id) === 'running';
  const start = () => {
    setActiveTask(props.task.id);
    void startRunInTask(props.task.id, props.run);
  };
  const open = () => {
    const url = runCommandUrl(props.run, ensureTaskPortBase(props.task.id));
    if (url) openCanvasBrowserAt(props.task.id, url);
  };

  return (
    <div style={{ display: 'flex', 'align-items': 'center', gap: '2px' }}>
      <button
        type="button"
        class="shell-toolbar-button"
        aria-pressed={running()}
        title={
          running() ? `Stop ${props.run.name}` : `Start ${props.run.name}: ${props.run.command}`
        }
        onClick={() => (running() ? stopRunInTask(props.task.id, props.run.id) : start())}
        style={toolbarBtnStyle(running())}
      >
        {running() ? <StopSmallIcon size={12} /> : <PlayIcon size={12} />}
        <span>{props.run.name}</span>
      </button>
      {/* Hidden, not removed, while stopped so the toolbar never shifts. */}
      <button
        type="button"
        class="shell-toolbar-button"
        aria-label={`Restart ${props.run.name}`}
        title={`Restart ${props.run.name}`}
        disabled={!running()}
        onClick={start}
        style={{ ...toolbarBtnStyle(false, true), visibility: running() ? 'visible' : 'hidden' }}
      >
        <RefreshIcon size={12} />
      </button>
      <Show when={props.run.url}>
        <button
          type="button"
          class="shell-toolbar-button"
          aria-label={`Open ${props.run.name} in the browser preview`}
          title={`Open ${props.run.name} in the browser preview`}
          onClick={open}
          style={toolbarBtnStyle(false, true)}
        >
          <ExternalLinkIcon size={12} />
        </button>
      </Show>
    </div>
  );
}
