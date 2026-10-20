import type { MapNode } from './model';

const fieldLabels: Record<string, string> = {
  title: 'title',
  detail: 'notes',
  kind: 'type',
  status: 'status',
  children: 'order of children',
  parent: 'position',
  rationale: 'rationale',
  answer: 'answer',
};

/** Tooltip for the ownership glyph: which fields the agent must not overwrite. */
export function ownershipTitle(userEdited: readonly string[] | undefined): string | undefined {
  if (!userEdited?.length) return;
  if (userEdited.includes('*')) return 'Created by you. The agent keeps it unless it overrides.';
  const fields = userEdited.map((field) => fieldLabels[field] ?? field).join(', ');
  return `Edited by you: ${fields}. The agent keeps these unless it overrides.`;
}

export function isProtected(item: Pick<MapNode, 'userEdited'>): boolean {
  return !!item.userEdited?.length;
}
