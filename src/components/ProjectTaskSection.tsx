import { sanitizeBranchPrefix, toBranchName } from '../lib/branch-name';
import { sectionLabelStyle, theme } from '../lib/theme';
import { DownloadIcon } from './icons';
import { SegmentedButtons } from './SegmentedButtons';
import {
  ProjectCheckbox,
  ProjectField,
  ProjectSection,
  projectButtonStyle,
  projectHintStyle,
  projectMonoInputStyle,
} from './ProjectDialogParts';
import type { ProjectSettingsForm } from './project-settings-form';

interface ProjectTaskSectionProps {
  form: ProjectSettingsForm;
  onImportWorktrees: () => void;
  onEnter: (e: KeyboardEvent) => void;
}

/** How new tasks branch, isolate and clean up in a Git project. */
export function ProjectTaskSection(props: ProjectTaskSectionProps) {
  const form = () => props.form;
  return (
    <ProjectSection title="Branches and worktrees">
      <ProjectField label="Branch prefix">
        {(id) => (
          <>
            <input
              id={id}
              class="input-field"
              type="text"
              value={form().branchPrefix()}
              onInput={(e) => form().setBranchPrefix(e.currentTarget.value)}
              onKeyDown={(e) => props.onEnter(e)}
              placeholder="task"
              style={projectMonoInputStyle}
            />
            {/* Hidden, not removed, so clearing the prefix doesn't shift the form. */}
            <div
              style={{
                ...projectHintStyle,
                'font-family': "'JetBrains Mono', monospace",
                visibility: form().branchPrefix().trim() ? 'visible' : 'hidden',
              }}
            >
              {sanitizeBranchPrefix(form().branchPrefix())}/{toBranchName('example-branch-name')}
            </div>
          </>
        )}
      </ProjectField>

      <ProjectField label="Worktree folder" aside="blank = .worktrees in the project">
        {(id) => (
          <>
            <input
              id={id}
              class="input-field"
              type="text"
              value={form().worktreeFolder()}
              onInput={(e) => form().setWorktreeFolder(e.currentTarget.value)}
              onKeyDown={(e) => props.onEnter(e)}
              placeholder="~/worktrees/project"
              style={projectMonoInputStyle}
            />
            {/* Hidden, not removed, so clearing the folder doesn't shift the form. */}
            <div
              style={{
                ...projectHintStyle,
                'font-family': "'JetBrains Mono', monospace",
                'overflow-wrap': 'anywhere',
                ...(form().worktreeFolderError() ? { color: theme.error } : {}),
                visibility: form().worktreeFolder().trim() ? 'visible' : 'hidden',
              }}
            >
              {form().worktreeFolderError() ??
                `${form().worktreeFolder().trim().replace(/\/+$/, '')}/${sanitizeBranchPrefix(
                  form().branchPrefix(),
                )}/${toBranchName('example-branch-name')}`}
            </div>
          </>
        )}
      </ProjectField>

      <ProjectField label="Default base branch" aside="blank = auto-detect main">
        {(id) => (
          <input
            id={id}
            class="input-field"
            type="text"
            value={form().defaultBaseBranch()}
            onInput={(e) => form().setDefaultBaseBranch(e.currentTarget.value)}
            onKeyDown={(e) => props.onEnter(e)}
            placeholder="main"
            style={projectMonoInputStyle}
          />
        )}
      </ProjectField>

      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
        <span style={sectionLabelStyle}>Default Git isolation</span>
        <SegmentedButtons
          options={[
            { value: 'worktree', label: 'Worktree' },
            { value: 'direct', label: 'Current branch' },
          ]}
          value={form().defaultGitIsolation()}
          onChange={(mode) => form().setDefaultGitIsolation(mode)}
        />
      </div>

      <ProjectCheckbox
        label="Delete branch and worktree when a task closes"
        checked={form().deleteBranchOnClose()}
        onChange={(checked) => form().setDeleteBranchOnClose(checked)}
      />

      <div style={{ display: 'flex', 'align-items': 'center', gap: '12px' }}>
        <span style={{ ...projectHintStyle, flex: '1' }}>
          Add worktrees that already exist in this repository as tasks.
        </span>
        <button
          class="btn-with-icon"
          type="button"
          onClick={() => props.onImportWorktrees()}
          style={projectButtonStyle}
        >
          <DownloadIcon size={12} />
          Import worktrees…
        </button>
      </div>
    </ProjectSection>
  );
}
