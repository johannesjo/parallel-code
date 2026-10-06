import { For, Show } from 'solid-js';
import type { EvidenceModelWhen } from '../../electron/shared/evidence';
import { DEFAULT_EVIDENCE_MODEL } from '../../electron/shared/evidence-settings';
import { planChecks, skipReasonText } from '../lib/evidence-plan';
import { theme } from '../lib/theme';
import { getProject, getTaskChecks } from '../store/store';
import type { Task } from '../store/types';

const MODEL_TEXT: Record<EvidenceModelWhen, string> = {
  off: 'The review model is off.',
  manual: 'The review model runs only when you click Run AI review.',
  handoff: 'The review model runs after every agent handoff.',
  risky: 'The review model runs after handoffs with flags, untested code or large diffs.',
};

const paragraph = { margin: '6px 0 0' };
const list = { margin: '4px 0 0', padding: '0 0 0 16px' };

/**
 * What a build will execute, from the same gate the build uses. The change is
 * not scanned yet, so a check held back by a changed test setup shows as running.
 */
export function EvidenceRunsHelp(props: { task: Task }) {
  const checks = () => getTaskChecks(props.task.id);
  const plan = () =>
    planChecks({
      checks: checks(),
      dockerMode: Boolean(props.task.dockerMode),
      flags: [],
      acceptedFlags: {},
    });
  const model = () => getProject(props.task.projectId)?.evidenceModel ?? DEFAULT_EVIDENCE_MODEL;

  return (
    <>
      <strong>Build evidence</strong>
      <p style={paragraph}>
        Reads the diff for test changes, source without related tests and risky edits.
      </p>
      <Show
        when={checks().length > 0}
        fallback={
          <p style={paragraph}>
            No checks are configured, so nothing is executed. Add a verify command or evidence
            checks in the project settings.
          </p>
        }
      >
        <Show when={plan().run.length > 0}>
          <p style={paragraph}>Then runs, on this machine in the task worktree:</p>
          <ul style={list}>
            <For each={plan().run}>
              {(check) => (
                <li>
                  {check.name}: <code>{check.command}</code>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={plan().skipped.length > 0}>
          <p style={paragraph}>Waits for a click:</p>
          <ul style={list}>
            <For each={plan().skipped}>
              {(check) => (
                <li>
                  {check.name}, {skipReasonText(check.reason)}
                </li>
              )}
            </For>
          </ul>
        </Show>
        <p style={{ ...paragraph, color: theme.fgMuted }}>
          If the change edits how checks run, such as package.json, lockfiles or test config, every
          check waits for a click. Checks also wait when the worktree has uncommitted changes or the
          integrity scan is incomplete.
        </p>
      </Show>
      <p style={paragraph}>{MODEL_TEXT[model().when]}</p>
    </>
  );
}
