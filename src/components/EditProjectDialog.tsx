import { createSignal, createEffect, createUniqueId, For, on, Show, type JSX } from 'solid-js';
import { Dialog } from './Dialog';
import { DialogFooter } from './DialogFooter';
import { updateProject, spConnection, listSpProjects, setProjectSpMapping } from '../store/store';
import type { SpProject } from '../../electron/shared/super-productivity';
import { theme } from '../lib/theme';
import type { Project } from '../store/types';
import { ImportWorktreesDialog } from './ImportWorktreesDialog';
import { RemoveProjectConfirm } from './RemoveProjectConfirm';
import { updateProjectCoordination } from '../store/projects';
import { isDocumentProject } from '../store/projects';
import {
  ProjectCheckbox,
  ProjectField,
  ProjectSection,
  projectInputStyle,
} from './ProjectDialogParts';
import { ProjectBookmarksField } from './ProjectBookmarksField';
import { ProjectColorPicker } from './ProjectColorPicker';
import { ProjectIconField } from './ProjectIconField';
import { ProjectFolderField } from './ProjectFolderField';
import { ProjectTaskSection } from './ProjectTaskSection';
import { ProjectVerificationSection } from './ProjectVerificationSection';
import { createProjectSettingsForm } from './project-settings-form';
import { DialogTabs, dialogTabId, dialogTabPanelId, type DialogTab } from './DialogTabs';

interface EditProjectDialogProps {
  project: Project | null;
  /** Opens on the verify command and evidence checks instead of the name. */
  focusChecks?: boolean;
  onClose: () => void;
}

type ProjectTab = 'general' | 'tasks' | 'verification';

export function EditProjectDialog(props: EditProjectDialogProps) {
  const titleId = createUniqueId();
  const tabPrefix = createUniqueId();
  const form = createProjectSettingsForm();
  const [tab, setTab] = createSignal<ProjectTab>('general');
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal('');
  const [showImportDialog, setShowImportDialog] = createSignal(false);
  const [confirmRemove, setConfirmRemove] = createSignal(false);
  const [spProjectId, setSpProjectId] = createSignal('');
  // null until loaded: the mapping is only saved from a list the user saw.
  const [spProjects, setSpProjects] = createSignal<SpProject[] | null>(null);
  // Drops a list that arrives after the dialog moved on to another project.
  let spProjectsLoad = 0;
  /** Branch and worktree settings only mean something where tasks run. */
  const isDocument = () => isDocumentProject(props.project ?? undefined);
  const showsTaskSettings = () => props.project?.isGitRepo !== false && !isDocument();
  // A document project runs no tasks, so it gets General alone and no tab strip.
  const tabs = (): DialogTab<ProjectTab>[] =>
    isDocument()
      ? [{ id: 'general', label: 'General' }]
      : [
          { id: 'general', label: 'General' },
          { id: 'tasks', label: 'Tasks' },
          { id: 'verification', label: 'Verification' },
        ];
  let nameRef!: HTMLInputElement;
  let verifyRef: HTMLInputElement | undefined;

  // Sync the form when a project opens. Keyed on identity, not fields: saving
  // updates the stored project while a peer-access save is still pending, and a
  // re-sync then would reset the form and move focus mid-save.
  createEffect(
    on(
      () => props.project,
      (p) => {
        if (!p) return;
        form.load(p);
        const opensChecks = props.focusChecks === true && !isDocumentProject(p);
        setTab(opensChecks ? 'verification' : 'general');
        setSaveError('');
        setConfirmRemove(false);
        setSpProjectId(p.superProductivityProjectId ?? '');
        setSpProjects(null);
        // Bumped on every opening, so a list still loading from an earlier one is dropped.
        const load = ++spProjectsLoad;
        if (spConnection() !== 'not_configured' && !isDocumentProject(p)) {
          void listSpProjects().then((list) => {
            if (load === spProjectsLoad) setSpProjects(list);
          });
        }
        requestAnimationFrame(() => (opensChecks && verifyRef ? verifyRef : nameRef)?.focus());
      },
    ),
  );

  const saveBlocker = () => {
    if (!form.name().trim()) return 'Enter a project name to save';
    if (form.worktreeFolderError()) return 'Fix the worktree folder to save';
    return undefined;
  };
  const canSave = () => saveBlocker() === undefined;
  const saveDisabled = () => !canSave() || saving();
  const saveOnEnter = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && canSave()) void handleSave();
  };

  async function handleSave() {
    if (!canSave() || !props.project || saving()) return;
    setSaving(true);
    setSaveError('');
    const projectId = props.project.id;
    const peerConsent = form.allowPeerAccess();
    const syncPolicy = showsTaskSettings();
    // Local fields save first: a failed peer-access update in the main process must
    // not drop unrelated edits. The dialog stays open to report and retry it.
    updateProject(projectId, form.updates());
    if (spProjects() !== null) setProjectSpMapping(projectId, spProjectId() || undefined);
    try {
      if (syncPolicy) await updateProjectCoordination(projectId, peerConsent);
      props.onClose();
    } catch (error) {
      setSaveError(String(error));
    } finally {
      setSaving(false);
    }
  }

  // Panels stay mounted and are only hidden, so a running "Suggest with AI"
  // or an unsaved bookmark draft survives a tab switch.
  const TabPanel = (panelProps: { id: ProjectTab; children: JSX.Element }) => (
    <div
      role={tabs().length > 1 ? 'tabpanel' : undefined}
      id={dialogTabPanelId(tabPrefix, panelProps.id)}
      aria-labelledby={tabs().length > 1 ? dialogTabId(tabPrefix, panelProps.id) : undefined}
      hidden={tab() !== panelProps.id}
      data-dialog-scroll={tab() === panelProps.id ? '' : undefined}
      style={{
        flex: '1 1 auto',
        'min-height': '0',
        'overflow-y': 'auto',
        // Reach into the panel padding so the scrollbar sits at its edge
        // and focus rings on the inputs are not clipped.
        margin: '0 -24px 0 -4px',
        padding: '4px 24px 4px 4px',
        display: tab() === panelProps.id ? 'flex' : 'none',
        'flex-direction': 'column',
        gap: '24px',
      }}
    >
      {panelProps.children}
    </div>
  );

  return (
    <Dialog
      open={props.project !== null}
      onClose={props.onClose}
      width="520px"
      labelledBy={titleId}
      // Fixed height: switching tabs must not resize the dialog under the pointer.
      // Tall enough that Verification, the longest tab, fits on common screens;
      // the 32px margin keeps the backdrop visible on short windows.
      panelStyle={{
        overflow: 'hidden',
        height: 'min(900px, calc(100vh - 32px))',
        'max-height': 'calc(100vh - 32px)',
      }}
    >
      <Show when={props.project}>
        {(project) => (
          <>
            <h2
              id={titleId}
              style={{
                'flex-shrink': '0',
                margin: '0',
                'font-size': '17px',
                color: theme.fg,
                'font-weight': '600',
              }}
            >
              Project settings
            </h2>

            <Show when={tabs().length > 1}>
              <DialogTabs
                tabs={tabs()}
                active={tab()}
                onChange={setTab}
                idPrefix={tabPrefix}
                label="Project settings sections"
              />
            </Show>

            <TabPanel id="general">
              <ProjectField label="Name">
                {(id) => (
                  <input
                    id={id}
                    ref={nameRef}
                    class="input-field"
                    type="text"
                    value={form.name()}
                    onInput={(e) => form.setName(e.currentTarget.value)}
                    onKeyDown={saveOnEnter}
                    style={projectInputStyle}
                  />
                )}
              </ProjectField>

              <ProjectColorPicker color={form.color()} onChange={form.setColor} />
              <ProjectIconField icon={form.icon()} color={form.color()} onChange={form.setIcon} />

              <ProjectFolderField
                projectId={project().id}
                path={project().path}
                onRelinked={() => props.onClose()}
                onRemove={() => setConfirmRemove(true)}
              />

              <Show when={spProjects()}>
                {(list) => (
                  <ProjectField
                    label="Super Productivity project"
                    hint="Tasks you focus here are created and tracked in this project. Without one, they land in the project open in Super Productivity, or its default project."
                  >
                    {(id) => (
                      <select
                        id={id}
                        class="project-select"
                        value={spProjectId()}
                        onChange={(e) => setSpProjectId(e.currentTarget.value)}
                      >
                        <option value="">Not linked</option>
                        <For each={list()}>
                          {(spProject) => <option value={spProject.id}>{spProject.title}</option>}
                        </For>
                        <Show when={spProjectId() && !list().some((sp) => sp.id === spProjectId())}>
                          <option value={spProjectId()}>(archived or deleted project)</option>
                        </Show>
                      </select>
                    )}
                  </ProjectField>
                )}
              </Show>
            </TabPanel>

            <Show when={!isDocument()}>
              <TabPanel id="tasks">
                <Show when={showsTaskSettings()}>
                  <ProjectTaskSection
                    form={form}
                    onImportWorktrees={() => setShowImportDialog(true)}
                    onEnter={saveOnEnter}
                  />

                  <ProjectSection title="Agent collaboration">
                    <ProjectCheckbox
                      label="Allow peer access between tasks"
                      checked={form.allowPeerAccess()}
                      onChange={form.setAllowPeerAccess}
                      description={
                        <>
                          Eligible top-level agents in this project can discover each other, read
                          output, and send messages held for your review. Messages never type into
                          terminals automatically. Running sessions get the tools after a supported
                          restart and resume; sessions with custom MCP configuration need separate
                          setup.
                        </>
                      }
                    />
                  </ProjectSection>
                </Show>

                <ProjectSection title="Terminal">
                  <ProjectBookmarksField
                    bookmarks={form.bookmarks()}
                    onChange={form.setBookmarks}
                  />
                </ProjectSection>
              </TabPanel>

              <TabPanel id="verification">
                <ProjectVerificationSection
                  form={form}
                  projectRoot={project().path}
                  verifyRef={(el) => (verifyRef = el)}
                />
              </TabPanel>
            </Show>

            {/* The error sits beside Save, where the retry happens. */}
            <DialogFooter
              error={saveError()}
              style={{
                'margin-top': 'auto',
                'padding-top': '16px',
                'border-top': `1px solid ${theme.border}`,
              }}
            >
              <button type="button" class="btn-secondary" onClick={() => props.onClose()}>
                Cancel
              </button>
              <button
                type="button"
                class="btn-primary"
                disabled={saveDisabled()}
                title={saveBlocker()}
                aria-busy={saving()}
                onClick={handleSave}
              >
                {saving() ? 'Saving…' : 'Save'}
              </button>
            </DialogFooter>
            <ImportWorktreesDialog
              open={showImportDialog()}
              project={project()}
              onClose={() => setShowImportDialog(false)}
            />
            <RemoveProjectConfirm
              projectId={confirmRemove() ? project().id : null}
              onDone={() => setConfirmRemove(false)}
              onRemoved={() => props.onClose()}
            />
          </>
        )}
      </Show>
    </Dialog>
  );
}
