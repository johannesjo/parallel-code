import { Index, Show, createEffect, createSignal, on, onCleanup } from 'solid-js';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { theme } from '../lib/theme';
import {
  WORKTREE_SCRIPT_MAX_LENGTH,
  defaultIncludes,
  includeRows,
  withIncludeMode,
} from '../lib/worktree-includes';
import type { GitIgnoredEntry } from '../ipc/types';
import type { WorktreeIncludeMode } from '../store/types';
import {
  ProjectCheckbox,
  ProjectField,
  ProjectSection,
  projectHintStyle,
  projectMonoInputStyle,
} from './ProjectDialogParts';
import type { ProjectSettingsForm } from './project-settings-form';

interface ProjectWorktreeSetupSectionProps {
  form: ProjectSettingsForm;
  projectRoot: string;
}

const scriptInputStyle = {
  ...projectMonoInputStyle,
  resize: 'vertical' as const,
  'min-height': '64px',
  'line-height': '1.45',
};

const SCRIPT_VARIABLES = '$PARALLEL_CODE_ROOT_PATH, $PARALLEL_CODE_WORKTREE, $PARALLEL_CODE_BRANCH';

/**
 * Opt-in worktree preparation for a Git project: what runs after a worktree
 * is created and before it is removed, and a saved choice of ignored files to
 * bring in. Everything empty keeps today's behaviour exactly.
 */
export function ProjectWorktreeSetupSection(props: ProjectWorktreeSetupSectionProps) {
  const form = () => props.form;
  const [candidates, setCandidates] = createSignal<GitIgnoredEntry[] | null>(null);

  // Probed only while the saved list is on: an unconfigured project costs nothing.
  createEffect(
    on(
      () => [form(), form().includesEnabled(), props.projectRoot] as const,
      ([current, enabled, projectRoot]) => {
        if (!enabled) return;
        let cancelled = false;
        onCleanup(() => (cancelled = true));
        setCandidates(null);
        invoke<GitIgnoredEntry[]>(IPC.GetGitignoredDirs, { projectRoot })
          .then((entries) => {
            if (cancelled) return;
            setCandidates(entries);
            // Seeded with today's defaults, so turning the list on changes
            // nothing until the user edits it.
            if (current.includesSeeding()) {
              current.setIncludes(defaultIncludes(entries));
              current.setIncludesSeeding(false);
            }
          })
          .catch(() => {
            if (cancelled) return;
            setCandidates([]);
            // Without the defaults to seed from, an empty list would silently
            // stop new tasks getting node_modules and .env: stay unset.
            if (current.includesSeeding()) {
              current.setIncludesSeeding(false);
              current.setIncludesEnabled(false);
            }
          });
      },
    ),
  );

  function setEnabled(enabled: boolean) {
    // Until the seed lands the form saves the list as unset, never as empty.
    form().setIncludesSeeding(enabled && form().includes().length === 0);
    form().setIncludesEnabled(enabled);
  }

  const rows = () => includeRows(candidates() ?? [], form().includes());

  return (
    <ProjectSection title="Worktree setup">
      <ProjectField
        label="Setup script"
        aside="optional"
        hint={
          <>
            Runs in a terminal of each new worktree task as soon as the task opens; the agent starts
            at the same time. Stops at the first failing command, and a failure is reported. Can use{' '}
            {SCRIPT_VARIABLES}.
          </>
        }
      >
        {(id) => (
          <textarea
            id={id}
            class="input-field"
            rows={3}
            spellcheck={false}
            maxLength={WORKTREE_SCRIPT_MAX_LENGTH}
            value={form().setupScript()}
            onInput={(e) => form().setSetupScript(e.currentTarget.value)}
            placeholder={'npm ci\ncp "$PARALLEL_CODE_ROOT_PATH/.env" .'}
            style={scriptInputStyle}
          />
        )}
      </ProjectField>

      <ProjectField
        label="Teardown script"
        aside="optional"
        hint="Runs in the worktree, after its agents stop and before the app removes it, when a task closes or merges with cleanup, for up to 2 minutes. If it fails, you are told and the worktree is still removed."
      >
        {(id) => (
          <textarea
            id={id}
            class="input-field"
            rows={2}
            spellcheck={false}
            maxLength={WORKTREE_SCRIPT_MAX_LENGTH}
            value={form().teardownScript()}
            onInput={(e) => form().setTeardownScript(e.currentTarget.value)}
            placeholder="docker compose down"
            style={scriptInputStyle}
          />
        )}
      </ProjectField>

      <ProjectCheckbox
        label="Save which ignored files new tasks bring in"
        checked={form().includesEnabled()}
        onChange={setEnabled}
        description="New tasks start with this selection instead of the built-in defaults. A symlink shares the main checkout's copy; a copy is independent but takes longer to create."
      />

      <Show when={form().includesEnabled()}>
        <div
          style={{
            display: 'flex',
            'flex-direction': 'column',
            gap: '4px',
            padding: '8px 10px',
            background: theme.bgElevated,
            'border-radius': 'var(--radius-sm)',
            border: `1px solid ${theme.border}`,
            'max-height': '220px',
            'overflow-y': 'auto',
            // Reserved so the list doesn't grow under the pointer when it loads.
            'min-height': '64px',
          }}
        >
          <Show
            when={candidates() !== null}
            fallback={<span style={projectHintStyle}>Checking ignored files…</span>}
          >
            <Show
              when={rows().length > 0}
              fallback={
                <span style={projectHintStyle}>This checkout has no ignored root entries.</span>
              }
            >
              {/* Index, not For: rows are rebuilt on every change, and a keyed
                  list would recreate the select being changed and drop focus. */}
              <Index each={rows()}>
                {(row) => (
                  <label
                    style={{
                      display: 'flex',
                      'align-items': 'center',
                      gap: '8px',
                      'font-size': '13px',
                    }}
                  >
                    <span
                      style={{
                        flex: '1',
                        'min-width': '0',
                        overflow: 'hidden',
                        'text-overflow': 'ellipsis',
                        'white-space': 'nowrap',
                        'font-family': "'JetBrains Mono', monospace",
                        color: row().present ? theme.fg : theme.fgSubtle,
                      }}
                      title={row().present ? row().name : `${row().name} is not in the checkout`}
                    >
                      {row().name}
                      <Show when={!row().present}> (missing)</Show>
                    </span>
                    <select
                      class="project-select"
                      aria-label={`How new tasks get ${row().name}`}
                      value={row().mode ?? ''}
                      onChange={(e) => {
                        const value = e.currentTarget.value;
                        const mode = value === '' ? null : (value as WorktreeIncludeMode);
                        form().setIncludes(withIncludeMode(form().includes(), row().name, mode));
                      }}
                      style={{ 'font-size': '12px', padding: '2px 6px' }}
                    >
                      <option value="">Not included</option>
                      <option value="symlink">Symlink</option>
                      <option value="copy">Copy</option>
                    </select>
                  </label>
                )}
              </Index>
            </Show>
          </Show>
        </div>
      </Show>
    </ProjectSection>
  );
}
