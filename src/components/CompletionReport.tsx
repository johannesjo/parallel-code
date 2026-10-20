import { For, Show } from 'solid-js';
import type { Task } from '../store/types';

/**
 * The child agent's own account of its work. Everything here is an agent claim;
 * `headSha` lets the report say when it describes an older commit.
 */
export function CompletionReport(props: { task: Task; headSha?: string }) {
  return (
    <>
      <Show when={props.task.completion}>
        {(completion) => (
          <>
            <Show
              when={
                props.task.reviewRevision !== undefined &&
                props.task.reviewRevision !== completion().reviewRevision
              }
            >
              <p>Historical report: this completion belongs to an earlier assignment.</p>
            </Show>
            <p>
              <Show
                when={completion().sourceCommit}
                fallback="Completion commit association unknown."
              >
                {(commit) => (
                  <>
                    Associated with <code>{commit().slice(0, 10)}</code>.
                    <Show when={props.headSha && commit() !== props.headSha}>
                      {' '}
                      Report is stale for the displayed commit.
                    </Show>
                  </>
                )}
              </Show>{' '}
              {completion().snapshotState === 'dirty'
                ? 'Worktree was dirty at completion.'
                : completion().snapshotState === 'unknown'
                  ? 'Worktree state at completion unknown.'
                  : 'Worktree was clean at completion.'}
            </p>
          </>
        )}
      </Show>
      <Show when={props.task.completion?.result} fallback={<p>No structured report provided</p>}>
        {(result) => (
          <>
            <p style={{ 'white-space': 'pre-wrap' }}>{result().summary}</p>
            <Show when={result().unresolvedIssues?.length}>
              <h4>Unresolved issues</h4>
              <ul>
                <For each={result().unresolvedIssues}>{(issue) => <li>{issue}</li>}</For>
              </ul>
            </Show>
            <Show when={result().verification?.checks.length}>
              <h4>Agent-reported verification</h4>
              <p>These checks are agent claims. The app has not proven they ran at this commit.</p>
              <ul>
                <For each={result().verification?.checks}>
                  {(check) => (
                    <li>
                      {check.name}: {check.result} · <code>{check.command}</code>
                      {check.reason ? ' · ' + check.reason : ''}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={result().artifacts?.length}>
              <h4>Reported artifacts</h4>
              <ul>
                <For each={result().artifacts}>
                  {(artifact) => (
                    <li>
                      {artifact.label ? artifact.label + ': ' : ''}
                      <code>{artifact.path}</code>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </>
        )}
      </Show>
    </>
  );
}
