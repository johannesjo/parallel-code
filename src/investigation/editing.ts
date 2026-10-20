import type { InvestigationRecord, Snapshot } from './state';
import { graphObject, validGraphId, type MapOperation } from '../../electron/shared/graph';

interface NoteText {
  title: string;
  detail: string;
}
export interface NoteDraft extends NoteText {
  base: NoteText;
  question: string;
}
/** Only unsent input belongs in renderer persistence. Saved content lives in the graph log. */
export interface ReasoningWorkspace {
  drafts: Record<string, NoteDraft>;
  /** Digest of the manual changes last sent to the agent, so unchanged edits are not resent. */
  sentChanges?: string;
}
const maxSentChanges = 100_000;
export const emptyWorkspace = (): ReasoningWorkspace => ({ drafts: {} });
export function updateDraft(
  workspace: ReasoningWorkspace,
  id: string,
  draft: NoteDraft | undefined,
): ReasoningWorkspace {
  if (draft) return { ...workspace, drafts: { ...workspace.drafts, [id]: draft } };
  const { [id]: _removed, ...drafts } = workspace.drafts;
  return { ...workspace, drafts };
}
export function getDraft(workspace: ReasoningWorkspace, id: string): NoteDraft | undefined {
  return Object.hasOwn(workspace.drafts, id) ? workspace.drafts[id] : undefined;
}
export function conflictFields(
  snapshot: Snapshot,
  id: string,
  draft?: NoteDraft,
): (keyof NoteText)[] {
  const current = snapshot.records.find((node) => node.id === id);
  return (['title', 'detail'] as const).filter(
    (field) =>
      current &&
      draft &&
      draft[field] !== draft.base[field] &&
      current[field] !== draft.base[field] &&
      current[field] !== draft[field],
  );
}
export function notePatch(
  snapshot: Snapshot,
  id: string,
  draft: NoteDraft,
  acceptConflict = false,
): MapOperation[] {
  if (
    !draft.title.trim() ||
    draft.title.length > 200 ||
    draft.detail.length > 8000 ||
    draft.question.length > 8000
  )
    throw new Error('Enter a title up to 200 characters and text up to 8000 characters');
  const current = snapshot.records.find((node) => node.id === id);
  if (!current) throw new Error('This node is no longer available.');
  if (!acceptConflict && conflictFields(snapshot, id, draft).length)
    throw new Error(
      'The graph updated this node. Open Details to compare and keep your changes, or discard the draft.',
    );
  const changes: Partial<NoteText> = {};
  for (const field of ['title', 'detail'] as const)
    if (draft[field] !== draft.base[field] && draft[field] !== current[field])
      changes[field] = draft[field];
  return Object.keys(changes).length ? [{ type: 'update', id, changes }] : [];
}
export function childNode(parent: string, kind?: InvestigationRecord['kind']): InvestigationRecord {
  const node: InvestigationRecord = {
    id: `user_${crypto.randomUUID()}`,
    parent,
    title: kind ? `New ${kind}` : 'New node',
    detail: '',
  };
  if (kind) {
    node.kind = kind;
    node.status =
      kind === 'hypothesis'
        ? 'untested'
        : kind === 'goal' || kind === 'question'
          ? 'unresolved'
          : 'proposed';
  }
  return node;
}
function validText(value: unknown): value is NoteText {
  return (
    graphObject(value) &&
    typeof value.title === 'string' &&
    value.title.length <= 200 &&
    typeof value.detail === 'string' &&
    value.detail.length <= 8000
  );
}
function validSentChanges(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length <= maxSentChanges);
}
export function restoreReasoningWorkspaces(
  value: unknown,
): Record<string, ReasoningWorkspace> | undefined {
  if (!graphObject(value)) return;
  const result: Record<string, ReasoningWorkspace> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (
      !key ||
      !graphObject(candidate) ||
      Object.keys(candidate).some((field) => field !== 'drafts' && field !== 'sentChanges') ||
      !graphObject(candidate.drafts) ||
      Object.keys(candidate.drafts).length > 200 ||
      !validSentChanges(candidate.sentChanges)
    )
      continue;
    const workspace = emptyWorkspace();
    if (candidate.sentChanges) workspace.sentChanges = candidate.sentChanges;
    let valid = true;
    for (const [id, draft] of Object.entries(candidate.drafts)) {
      if (
        !validGraphId(id) ||
        !validText(draft) ||
        !graphObject(draft) ||
        !validText(draft.base) ||
        typeof draft.question !== 'string' ||
        draft.question.length > 8000
      ) {
        valid = false;
        break;
      }
      workspace.drafts[id] = {
        title: draft.title,
        detail: draft.detail,
        base: { title: draft.base.title, detail: draft.base.detail },
        question: draft.question,
      };
    }
    if (valid)
      Object.defineProperty(result, key, {
        value: workspace,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
  return Object.keys(result).length ? result : undefined;
}
