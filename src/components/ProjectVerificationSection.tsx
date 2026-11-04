import { keepCheckIds } from '../lib/check-suggestion';
import { store } from '../store/store';
import { ProjectChecksFields } from './ProjectChecksFields';
import { SuggestChecksButton } from './SuggestChecksButton';
import { ProjectCheckbox, ProjectField, projectMonoInputStyle } from './ProjectDialogParts';
import type { ProjectSettingsForm } from './project-settings-form';

interface ProjectVerificationSectionProps {
  form: ProjectSettingsForm;
  projectRoot: string;
  /** Receives the verify input so the dialog can open focused on it. */
  verifyRef: (el: HTMLInputElement) => void;
}

/** Verify command, project checks and coverage: what proves a task's change works. */
export function ProjectVerificationSection(props: ProjectVerificationSectionProps) {
  const form = () => props.form;
  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '18px' }}>
      {/* First, since it fills both the verify command and the checks below. */}
      <div style={{ 'margin-bottom': '8px' }}>
        <SuggestChecksButton
          projectRoot={props.projectRoot}
          model={store.reviewModel}
          label="Suggest verify command and checks with AI"
          large
          onSuggest={(suggestion) => {
            // Keep what the user has when the model has nothing for a field.
            if (suggestion.verifyCommand) form().setVerifyCommand(suggestion.verifyCommand);
            if (suggestion.checks.length > 0)
              form().setEvidenceChecks(keepCheckIds(form().evidenceChecks(), suggestion.checks));
          }}
        />
      </div>
      <ProjectField
        label="Verify command"
        aside="runs in the task worktree"
        hint={
          <>
            Runs in the background after agent turns, from the Finish dialog, when an agent calls{' '}
            <code>land_self</code>, and before the coordinator merges. A failure is advisory in the
            Finish dialog, but <code>land_self</code> and <code>merge_task</code> refuse to merge
            until it passes. <code>PARALLEL_CODE_TASK_ID</code> and{' '}
            <code>PARALLEL_CODE_BRANCH</code> are set for namespacing shared resources.
          </>
        }
      >
        {(id) => (
          <input
            id={id}
            ref={(el) => props.verifyRef(el)}
            class="input-field"
            type="text"
            value={form().verifyCommand()}
            onInput={(e) => form().setVerifyCommand(e.currentTarget.value)}
            placeholder="npm run typecheck && npm test"
            style={projectMonoInputStyle}
          />
        )}
      </ProjectField>
      <ProjectCheckbox
        label="Run it in the background after each agent turn"
        description={
          <>
            Once an agent goes idle with a new commit, the app runs the command at low priority, so
            the Finish dialog already has the result. It skips Docker tasks, uncommitted changes and
            changes to how checks run, and stops when the agent starts working again.
          </>
        }
        checked={form().verifyAutoRun()}
        onChange={(checked) => form().setVerifyAutoRun(checked)}
      />
      <ProjectChecksFields
        checks={form().evidenceChecks()}
        onChecksChange={(checks) => form().setEvidenceChecks(checks)}
      />

      <ProjectField
        label="Coverage report path"
        aside="relative to repo root"
        hint={
          <>
            Leave blank to try <code>coverage/coverage-summary.json</code>, then{' '}
            <code>coverage/lcov.info</code>.
          </>
        }
      >
        {(id) => (
          <input
            id={id}
            class="input-field"
            type="text"
            value={form().coverageReportPath()}
            onInput={(e) => form().setCoverageReportPath(e.currentTarget.value)}
            placeholder="coverage/coverage-summary.json"
            style={projectMonoInputStyle}
          />
        )}
      </ProjectField>
    </div>
  );
}
