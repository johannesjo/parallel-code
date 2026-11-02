import { For, Show, createSignal, untrack, type JSX } from 'solid-js';
import { VERIFY_CHECK_ID, type CheckKind, type ProjectCheck } from '../../electron/shared/checks';
import type { CheckSuggestion } from '../lib/check-suggestion';
import { dialogButtonStyle, theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { getProjectChecks } from '../store/check-suite-state';
import { getProject } from '../store/projects';
import { setReviewChecks } from '../store/review-run';
import { setTaskReviewModel, taskReviewModel } from '../store/task-review';
import type { Task } from '../store/types';
import { finalizeChecks } from './ProjectChecksFields';
import { PlayIcon } from './icons';
import { ReviewerMenu } from './ReviewerMenu';
import { SuggestChecksButton } from './SuggestChecksButton';

// Kinds most projects have; while one is missing, the list offers to set checks up.
const COMMON_KINDS: readonly CheckKind[] = ['static', 'unit', 'e2e'];

/** The suggested checks the project does not have yet, named and with ids as Save would give them. */
function newSuggestedChecks(
  current: readonly ProjectCheck[],
  suggestion: CheckSuggestion,
): ProjectCheck[] {
  const has = (command: string) => current.some((check) => check.command === command);
  const verify: ProjectCheck[] =
    suggestion.verifyCommand && !current.some((check) => check.id === VERIFY_CHECK_ID)
      ? [
          {
            id: VERIFY_CHECK_ID,
            name: 'Verify',
            kind: 'custom',
            command: suggestion.verifyCommand,
            run: 'auto',
          },
        ]
      : [];
  const added = suggestion.checks.filter((check) => !has(check.command));
  const existing = current.filter((check) => check.id !== VERIFY_CHECK_ID);
  const named = finalizeChecks([...existing, ...added]) ?? [];
  return [...verify, ...named.slice(existing.length)];
}

const row: JSX.CSSProperties = {
  display: 'grid',
  'grid-template-columns': '16px minmax(0, 1fr)',
  gap: '0 8px',
  'align-items': 'baseline',
};

const hint: JSX.CSSProperties = { 'font-size': sf(12), color: theme.fgSubtle };

/**
 * Picks what a review runs in this project, shown before the project's first
 * review and from Change settings after. The reviewer always runs: the review is
 * built from it. Until the project saves a pick, checks set to Ticked start
 * picked and the others, usually slow, unpicked.
 */
export function ReviewChecksPicker(props: {
  task: Task;
  onCancel: () => void;
  /** Called once the pick is saved. */
  onStart: () => void;
}) {
  const project = () => getProject(props.task.projectId);
  const checks = () => getProjectChecks(props.task.projectId);
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(
    new Set(
      untrack(
        () =>
          project()?.reviewChecks ??
          checks()
            .filter((check) => check.run === 'auto')
            .map((check) => check.id),
      ),
    ),
  );
  // Suggested checks stay unsaved, and unticked, until the user picks them and starts.
  const [suggested, setSuggested] = createSignal<ProjectCheck[]>([]);
  const rows = () => [...checks(), ...suggested()];
  const missingKinds = () =>
    !checks().some((check) => check.id === VERIFY_CHECK_ID) ||
    COMMON_KINDS.some((kind) => !checks().some((check) => check.kind === kind));
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // Applied on Start, so Cancel leaves the task's reviewer as it was.
  const [model, setModel] = createSignal(untrack(() => taskReviewModel(props.task.id)));
  const start = () => {
    const current = taskReviewModel(props.task.id);
    const next = model();
    if (
      next.provider !== current.provider ||
      next.model !== current.model ||
      next.effort !== current.effort
    )
      setTaskReviewModel(props.task.id, next);
    const adopt = suggested().filter((check) => picked().has(check.id));
    setReviewChecks(props.task.id, {
      ids: rows()
        .map((check) => check.id)
        .filter((id) => picked().has(id)),
      verifyCommand: adopt.find((check) => check.id === VERIFY_CHECK_ID)?.command,
      newChecks: adopt.filter((check) => check.id !== VERIFY_CHECK_ID),
    });
    props.onStart();
  };

  return (
    <fieldset
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: '10px',
        margin: '8px 0 0',
        padding: '12px 14px',
        border: `1px solid ${theme.border}`,
        'border-radius': 'var(--radius-md)',
      }}
    >
      <legend style={{ padding: '0 4px', color: theme.fgMuted, 'font-size': sf(12) }}>
        What a review runs in {project()?.name ?? 'this project'}
      </legend>
      <label style={row}>
        <input type="checkbox" checked disabled />
        <span>
          What changed, risks and scores
          <span style={{ ...hint, display: 'block' }}>Always on: the review is built from it.</span>
        </span>
      </label>
      <div style={{ ...row, 'align-items': 'center' }}>
        <span />
        <span style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
          <span style={hint}>Reviewer</span>
          <ReviewerMenu class="review-control" value={model()} onChange={setModel} />
        </span>
      </div>
      <Show when={!checks().some((check) => check.id === VERIFY_CHECK_ID)}>
        <label style={{ ...row, color: theme.fgMuted }}>
          <input type="checkbox" disabled />
          <span>
            Verify
            <span style={{ ...hint, display: 'block' }}>No verify command set</span>
          </span>
        </label>
      </Show>
      <For each={rows()}>
        {(check) => (
          <label style={row}>
            <input
              type="checkbox"
              checked={picked().has(check.id)}
              onChange={() => toggle(check.id)}
            />
            <span style={{ 'min-width': '0' }}>
              {check.name}
              <Show when={suggested().includes(check)}>
                <span style={hint}> · suggested</span>
              </Show>
              <code
                style={{
                  ...hint,
                  display: 'block',
                  'overflow-wrap': 'anywhere',
                  'font-family': "'JetBrains Mono', monospace",
                }}
              >
                {check.command}
              </code>
            </span>
          </label>
        )}
      </For>
      <Show when={missingKinds() && suggested().length === 0}>
        <div style={row}>
          <span />
          <SuggestChecksButton
            projectRoot={project()?.path ?? ''}
            model={taskReviewModel(props.task.id)}
            label="Set up checks with AI"
            doneHint="Tick the ones to run; they are saved for the project when the review starts."
            onSuggest={(suggestion) => setSuggested(newSuggestedChecks(checks(), suggestion))}
          />
        </div>
      </Show>
      <div style={{ display: 'flex', gap: '8px', 'align-items': 'center', 'padding-top': '4px' }}>
        <span style={{ ...hint, flex: '1' }}>
          Ticked checks run in the task worktree unless held back; the reviewer waits for their
          results. Checks are saved for the project, the reviewer for this task.
        </span>
        <button type="button" style={dialogButtonStyle(false)} onClick={() => props.onCancel()}>
          Cancel
        </button>
        <button type="button" class="btn-with-icon" style={dialogButtonStyle(true)} onClick={start}>
          <PlayIcon size={12} />
          Start review
        </button>
      </div>
    </fieldset>
  );
}
