import { openDocumentWorkspace } from '../documents/store';
import { errMessage } from '../lib/log';
import { openInEditor, revealItemInDir } from '../lib/shell';
import { withViewTransition } from '../lib/viewTransition';
import { openGitHubIssues } from '../store/github';
import { openKanban } from '../store/kanban';
import { isDocumentProject } from '../store/projects';
import { isProjectMissing, showNotification, startProjectTask, store } from '../store/store';
import type { Project } from '../store/types';
import { ContextMenu, type MoreMenuItem } from './chat/MoreMenu';
import {
  DocumentIcon,
  FolderIcon,
  GitHubIcon,
  PencilIcon,
  PlanIcon,
  PlusIcon,
  TrashIcon,
} from './icons';
/** Dialogs the menu opens; whoever renders the menu owns them. */
export interface ProjectMenuDialogs {
  editSettings: (project: Project) => void;
  remove: (projectId: string) => void;
}

function openFolder(path: string): void {
  const action = store.editorCommand
    ? openInEditor(store.editorCommand, path)
    : revealItemInDir(path);
  action.catch((err) => showNotification(`Could not open project folder: ${errMessage(err)}`));
}

/** Views that need the project's folder; a missing folder only offers settings and removal. */
function viewItems(project: Project): MoreMenuItem[] {
  if (isDocumentProject(project))
    return [
      {
        label: 'Open workspace',
        icon: <DocumentIcon size={14} />,
        run: () => void openDocumentWorkspace(project.id),
      },
    ];
  return [
    {
      label: 'New task',
      icon: <PlusIcon size={14} />,
      run: () => withViewTransition(() => startProjectTask(project.id)),
    },
    {
      label: 'Plan board',
      icon: <PlanIcon size={14} />,
      run: () => withViewTransition(() => openKanban(project.id)),
    },
    {
      label: 'GitHub issues',
      icon: <GitHubIcon size={14} />,
      run: () => openGitHubIssues(project.id),
    },
    {
      label: store.editorCommand ? 'Open in editor' : 'Show in file manager',
      icon: <FolderIcon size={14} />,
      run: () => openFolder(project.path),
    },
  ];
}

/** What a click on a sidebar project row offers. */
export function projectMenuItems(
  project: Project,
  folderMissing: boolean,
  dialogs: ProjectMenuDialogs,
): MoreMenuItem[] {
  return [
    ...(folderMissing ? [] : viewItems(project)),
    {
      label: 'Settings…',
      icon: <PencilIcon size={14} />,
      run: () => dialogs.editSettings(project),
    },
    {
      label: 'Remove project…',
      icon: <TrashIcon size={14} />,
      run: () => dialogs.remove(project.id),
    },
  ];
}

/** A project's menu opened at a point; shared by the sidebar rows and the task header chip. */
export function ProjectMenu(props: {
  project: Project;
  at: { x: number; y: number };
  dialogs: ProjectMenuDialogs;
  onClose: () => void;
}) {
  return (
    <ContextMenu
      items={projectMenuItems(props.project, isProjectMissing(props.project.id), props.dialogs)}
      at={props.at}
      label={`${props.project.name} actions`}
      onClose={props.onClose}
    />
  );
}

/** Where a click opened the menu; a keyboard click reports 0,0, so use the element's foot. */
export function menuPointFor(event: MouseEvent | undefined, element: Element | null) {
  if (event && (event.clientX || event.clientY)) return { x: event.clientX, y: event.clientY };
  const rect = element?.getBoundingClientRect();
  return { x: rect?.left ?? 0, y: rect?.bottom ?? 0 };
}
