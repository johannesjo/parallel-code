import { Show, type JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { CandidateOutputDialog } from './CandidateOutputDialog';
import { openCandidateOutput, resetWorkspaceUi } from './workspace-ui';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('../components/Dialog', () => ({
  Dialog: (props: { open: boolean; children: JSX.Element }) => (
    <Show when={props.open}>{props.children}</Show>
  ),
}));
vi.mock('../store/projects', () => ({ getProject: () => ({ path: '/project' }) }));
vi.mock('./store', () => ({
  documentStore: {
    projectId: 'project',
    runs: {
      run: {
        instruction: 'Improve the document',
        candidates: [
          { id: 'first', label: 'A', agentName: 'Codex', status: 'running' },
          { id: 'second', label: 'B', agentName: 'Codex', status: 'done' },
        ],
      },
    },
  },
  modelLabel: () => '',
}));

let dispose: (() => void) | undefined;
let replies: ((text: string) => void)[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  resetWorkspaceUi();
  replies = [];
  vi.mocked(invoke).mockImplementation(
    () => new Promise<string>((resolve) => replies.push(resolve)),
  );
  openCandidateOutput({ runId: 'run', candidateId: 'first' });
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <CandidateOutputDialog />, host);
});

afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('keeps one log read in flight and resumes polling after it finishes', async () => {
  await vi.advanceTimersByTimeAsync(3000);
  expect(invoke).toHaveBeenCalledTimes(1);
  replies[0]('Initial output');
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('pre')?.textContent).toBe('Initial output');
  await vi.advanceTimersByTimeAsync(1000);
  expect(invoke).toHaveBeenCalledTimes(2);
  replies[1]('New output');
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('pre')?.textContent).toBe('New output');
});

it('loads a newly selected finished candidate after the pending read without showing stale output', async () => {
  openCandidateOutput({ runId: 'run', candidateId: 'second' });
  expect(invoke).toHaveBeenCalledTimes(1);
  replies[0]('Stale output');
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('pre')?.textContent).not.toContain('Stale output');
  expect(invoke).toHaveBeenLastCalledWith(IPC.ReadDocumentCandidateLog, {
    projectRoot: '/project',
    runId: 'run',
    candidateId: 'second',
  });
  replies[1]('Second candidate output');
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('pre')?.textContent).toBe('Second candidate output');
});

it('does not start another read after unmounting with a pending target change', async () => {
  openCandidateOutput({ runId: 'run', candidateId: 'second' });
  dispose?.();
  dispose = undefined;
  replies[0]('Old output');
  await vi.advanceTimersByTimeAsync(5000);
  expect(invoke).toHaveBeenCalledTimes(1);
});
