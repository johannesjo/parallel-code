import { mapNodeKinds, type MapNodeKind, type MindMapDocument } from '../graph/model';
import { noteTypes } from '../graph/presentation';
import { isProtected } from '../graph/ownership';
import { branchAgentAction, type BranchIntent } from '../graph/agentActions';
import type { NodeAction } from '../graph/NodeContextMenu';
import {
  InfoIcon,
  MentionIcon,
  PencilIcon,
  PersonIcon,
  PlusIcon,
  TrashIcon,
} from '../components/icons';

/** Everything a menu can do to one node; the editor binds these to its state. */
export interface NodeCommands {
  rename: () => void;
  notes: () => void;
  addChild: () => void;
  addSibling: () => void;
  moveSibling: (direction: -1 | 1) => void;
  nest: () => void;
  outdent: () => void;
  setKind: (kind: MapNodeKind) => void;
  toggle: () => void;
  release: () => void;
  remove: () => void;
  ask?: (intent: BranchIntent) => void;
  reference?: () => void;
}

export interface NodeActionContext {
  document: MindMapDocument;
  id: string;
  collapsed: boolean;
  showOwnership: boolean;
  commands: NodeCommands;
}

/** Same list for the context menu and the toolbar ••• menu, so both stay complete. */
export function nodeActions(context: NodeActionContext): NodeAction[] {
  const node = context.document.records.find((record) => record.id === context.id);
  if (!node) return [];
  const { commands } = context;
  return [
    { label: 'Rename', shortcut: 'F2', icon: PencilIcon, run: commands.rename },
    { label: 'Edit notes', icon: InfoIcon, run: commands.notes },
    {
      label: 'Node type',
      children: mapNodeKinds.map((kind) => ({
        label: kind === 'idea' ? 'Plain' : noteTypes[kind].label,
        checked: (node.kind ?? 'idea') === kind,
        run: () => commands.setKind(kind),
      })),
    },
    ...structureActions(context),
    ...agentActions(context, isProtected(node)),
    {
      label: 'Delete branch',
      shortcut: 'Del',
      separator: true,
      danger: true,
      icon: TrashIcon,
      disabled: !node.parent,
      run: commands.remove,
    },
  ];
}

function structureActions(context: NodeActionContext): NodeAction[] {
  const { document, id, commands } = context;
  const node = document.records.find((record) => record.id === id);
  const siblings = document.records.filter((record) => record.parent === node?.parent);
  const index = siblings.findIndex((record) => record.id === id);
  const grandparent = document.records.find((record) => record.id === node?.parent)?.parent;
  const child = !!node?.parent;
  return [
    {
      label: 'Add child',
      shortcut: 'Tab',
      separator: true,
      icon: PlusIcon,
      run: commands.addChild,
    },
    {
      label: 'Add sibling',
      shortcut: 'Enter',
      icon: PlusIcon,
      disabled: !child,
      run: commands.addSibling,
    },
    {
      label: 'Move up',
      shortcut: 'Alt+Shift+↑',
      separator: true,
      disabled: index < 1,
      run: () => commands.moveSibling(-1),
    },
    {
      label: 'Move down',
      shortcut: 'Alt+Shift+↓',
      disabled: !child || index >= siblings.length - 1,
      run: () => commands.moveSibling(1),
    },
    { label: 'Nest under previous idea', disabled: index < 1, run: commands.nest },
    {
      label: 'Move one level up',
      shortcut: 'Shift+Tab',
      disabled: !grandparent,
      run: commands.outdent,
    },
    {
      label: context.collapsed ? 'Expand branch' : 'Collapse branch',
      separator: true,
      disabled: !document.records.some((record) => record.parent === id),
      run: commands.toggle,
    },
  ];
}

function agentActions(context: NodeActionContext, owned: boolean): NodeAction[] {
  const { commands } = context;
  const actions: NodeAction[] = [];
  if (commands.ask) actions.push(branchAgentAction(commands.ask));
  if (commands.reference)
    actions.push({ label: 'Reference in chat', icon: MentionIcon, run: commands.reference });
  if (context.showOwnership && owned)
    actions.push({
      label: 'Release to agent',
      title: 'Let the agent change or remove this idea again.',
      icon: PersonIcon,
      run: commands.release,
    });
  if (actions.length) actions[0] = { ...actions[0], separator: true };
  return actions;
}
