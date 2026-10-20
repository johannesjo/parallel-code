import type { MapData } from '../graph/model';
import {
  children,
  createEffect,
  createMemo,
  createSignal,
  Index,
  onCleanup,
  Show,
  untrack,
  type JSX,
} from 'solid-js';
import {
  CommentIcon,
  DownloadIcon,
  InfoIcon,
  MentionIcon,
  PencilIcon,
  PersonIcon,
  PlusIcon,
  RedoIcon,
  TrashIcon,
  UndoIcon,
} from '../components/icons';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { unwrap } from 'solid-js/store';
import { store } from '../store/core';
import { createInlineEditing } from '../graph/inlineEditing';
import { createReducedMotion } from '../graph/reducedMotion';
import { focusRecord } from '../graph/focus';
import { branchAgentAction, type BranchRequest } from '../graph/agentActions';
import { NodeContextMenu, type NodeAction } from '../graph/NodeContextMenu';
import { nodeTrail, visibleNodes } from '../graph/model';
import { InvestigationGraph } from './InvestigationGraph';
import { GraphSearch } from './GraphSearch';
import { branchSnapshot } from './navigate';
import { InvestigationInspector } from './InvestigationInspector';
import { OptionsComparison } from './OptionsComparison';
import { NodeBadges } from './NodeBadges';
import { noteTypes } from './presentation';
import { exportReasoningGraphAs } from './export';
import { exportFormats, type ExportFormat } from '../graph/graphExport';
import { createEditHistory } from '../graph/editHistory';
import {
  conflictMessage,
  describeSaveFailure,
  retriedMessage,
  type SaveFailure,
} from './saveErrors';
import { recordEmphasis, type InvestigationRecord, type Snapshot } from './state';
import {
  childNode,
  notePatch,
  conflictFields,
  emptyWorkspace,
  getDraft,
  updateDraft,
  type NoteDraft,
  type ReasoningWorkspace,
} from './editing';
import {
  applyMapOperations,
  graphDifference,
  mapNodeKinds,
  type GraphSource,
  type MapNodeKind,
  type MapOperation,
} from '../../electron/shared/graph';
import './investigation.css';

interface Props {
  graphKey: string;
  snapshot?: Snapshot;
  visible: boolean;
  defaultZoom?: number;
  controls?: JSX.Element;
  notices?: JSX.Element;
  actions?: JSX.Element;
  overlay?: JSX.Element;
  loading?: boolean;
  /** Live session activity overrides saved activeId; standalone examples may omit it. */
  sessionWorking?: boolean;
  /** The agent is still writing its first report; the map is shown grayed out. */
  drafting?: boolean;
  onReference?: (node: InvestigationRecord, revision: number) => void;
  onBranchRequest?: (request: BranchRequest) => void;
  taskActions?: (id: string, map: MapData & { revision: number }) => NodeAction[];
  renderTaskBadge?: (id: string) => JSX.Element;
  workspace?: ReasoningWorkspace;
  onWorkspace?: (workspace: ReasoningWorkspace) => void;
  onCommit?: (base: Snapshot, operations: MapOperation[]) => Promise<Snapshot>;
  /** Reloads the newest revision; resolves once `snapshot` reflects it. Enables conflict retries. */
  refresh?: () => Promise<void>;
  onOpenSource?: (source: GraphSource) => Promise<void>;
  /** Resolves false when a task-relative source file is missing; undefined when unknown. */
  onCheckSource?: (source: GraphSource) => Promise<boolean | undefined>;
  /** Scrolls the agent terminal to the last agent update that touched the record; false when none is anchored. */
  onJumpToTranscript?: (recordId: string) => boolean;
  /** Resolves to 'queued' when the host holds the question until the agent is ready. */
  onAsk?: (
    note: InvestigationRecord,
    question: string,
    viewedRevision: number,
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- hosts without a queue return nothing
  ) => Promise<void | 'queued'>;
  askBlocker?: string;
}
interface CommitOptions {
  after?: (saved: Snapshot) => void;
  /** Replaying a recorded edit; on failure the history entry goes back to its stack. */
  undoing?: 'undo' | 'redo';
  /** Message for failures without a readable reason. */
  failure?: string;
}
interface Delivery {
  before: Snapshot;
  operations: MapOperation[];
  undoing?: 'undo' | 'redo';
  after?: (saved: Snapshot) => void;
  /** Whether a revision conflict may be retried once on the refreshed graph. */
  retry: boolean;
  notice?: string;
}
interface Removal {
  record: InvestigationRecord;
  count: number;
}

function descendants(records: InvestigationRecord[], id: string): number {
  return records
    .filter((node) => node.parent === id)
    .reduce((sum, child) => sum + 1 + descendants(records, child.id), 0);
}

export function ReasoningGraph(props: Props) {
  const overlay = children(() => props.overlay);
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const [localWorkspace, setLocalWorkspace] = createSignal(emptyWorkspace());
  const workspace = () => props.workspace ?? localWorkspace();
  const history = createEditHistory<Snapshot>(50);
  const [message, setMessage] = createSignal('');
  const [sending, setSending] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  let pendingCommit: Promise<boolean> | undefined;
  const [committed, setCommitted] = createSignal<Snapshot>();
  const latest = () => {
    const local = committed(),
      incoming = props.snapshot;
    return local && (!incoming || local.revision >= incoming.revision) ? local : incoming;
  };
  const stale = (key: string) => disposed || props.graphKey !== key;
  function change(next: ReasoningWorkspace) {
    if (props.onWorkspace) props.onWorkspace(next);
    else setLocalWorkspace(next);
  }
  function dropDrafts(before: Snapshot, saved: Snapshot) {
    const removed = new Set(
      before.records
        .filter((node) => !saved.records.some((current) => current.id === node.id))
        .map((node) => node.id),
    );
    if (!removed.size) return;
    change({
      ...workspace(),
      drafts: Object.fromEntries(
        Object.entries(workspace().drafts).filter(([id]) => !removed.has(id)),
      ),
    });
  }
  function accepted(delivery: Delivery, saved: Snapshot) {
    const incoming = props.snapshot;
    const superseded = !!incoming && incoming.revision > saved.revision;
    // Later agent updates do not invalidate the edit; undo replays its inverse on top of them.
    if (!delivery.undoing)
      history.push({ before: delivery.before, after: structuredClone(unwrap(saved)) });
    setCommitted(superseded ? undefined : saved);
    setDisplayed(superseded ? incoming : saved);
    setSaving(false);
    dropDrafts(delivery.before, saved);
    setMessage(delivery.notice ?? 'Changes saved to your graph.');
    delivery.after?.(saved);
  }
  function failed(delivery: Delivery, failure: SaveFailure) {
    setSaving(false);
    // A transient error leaves the step replayable; only a changed graph invalidates it.
    if (delivery.undoing && failure.conflict) history.reset();
    else if (delivery.undoing) history.unstep(delivery.undoing === 'redo');
    setMessage(failure.message);
  }
  async function send(
    deliver: NonNullable<Props['onCommit']>,
    delivery: Delivery,
  ): Promise<boolean> {
    const key = props.graphKey;
    try {
      const saved = await deliver(delivery.before, delivery.operations);
      if (stale(key)) return false;
      untrack(() => accepted(delivery, saved));
      return true;
    } catch (error) {
      if (stale(key)) return false;
      const failure = describeSaveFailure(error, 'Could not save node.');
      if (failure.conflict && delivery.retry) return retry(deliver, delivery);
      untrack(() => failed(delivery, failure));
      return false;
    }
  }
  async function retry(
    deliver: NonNullable<Props['onCommit']>,
    delivery: Delivery,
  ): Promise<boolean> {
    const key = props.graphKey;
    try {
      await props.refresh?.();
      if (stale(key)) return false;
      const base = untrack(latest);
      if (!base) throw new Error(conflictMessage);
      const before = structuredClone(unwrap(base));
      applyMapOperations(before, delivery.operations);
      return await send(deliver, { ...delivery, before, retry: false, notice: retriedMessage });
    } catch {
      if (stale(key)) return false;
      untrack(() => failed(delivery, { conflict: true, message: conflictMessage }));
      return false;
    }
  }
  /** Validate locally, then save; returns false when nothing was sent. */
  function commit(operations: MapOperation[], options: CommitOptions = {}) {
    const base = latest();
    if (!base) {
      setMessage('No graph to save to yet.');
      return false;
    }
    if (saving()) {
      setMessage('Wait for the current save to finish.');
      return false;
    }
    if (!operations.length) {
      options.after?.(base);
      return true;
    }
    const before = structuredClone(unwrap(base));
    let next: Snapshot;
    try {
      next = applyMapOperations(before, operations);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : (options.failure ?? 'Could not save.'));
      return false;
    }
    const delivery: Delivery = {
      before,
      operations,
      undoing: options.undoing,
      after: options.after,
      retry: !!props.refresh,
    };
    const deliver = props.onCommit;
    if (!deliver) {
      accepted(delivery, next);
      return true;
    }
    setSaving(true);
    const pending = send(deliver, delivery);
    pendingCommit = pending;
    void pending.finally(() => {
      if (pendingCommit === pending) pendingCommit = undefined;
    });
    return true;
  }
  function afterInlineSave(action: () => void) {
    const key = props.graphKey;
    if (!inline.save()) return;
    if (pendingCommit)
      void pendingCommit.then((ok) =>
        untrack(() => {
          if (ok && !stale(key)) action();
        }),
      );
    else action();
  }
  function undo(redo = false) {
    const current = latest();
    if (!current || saving()) return;
    inline.reset();
    const entry = history.step(redo);
    if (!entry) return;
    const [from, to] = redo ? [entry.before, entry.after] : [entry.after, entry.before];
    const sent = commit(graphDifference(from, to, { restore: true }), {
      undoing: redo ? 'redo' : 'undo',
      after: (saved) => {
        setDetailsOpen(false);
        const records = visibleNodes(saved.records, collapsed());
        const target = records.find((node) => node.id === selected()) ?? records[0];
        if (target) focusNode(target.id);
      },
    });
    if (sent) return;
    // The agent changed the notes this edit touched; the recorded steps no longer apply.
    history.reset();
    setMessage('Undo is no longer available because the agent changed that part of the graph.');
  }
  const [rendererVisible, setRendererVisible] = createSignal(false);
  const [displayed, setDisplayed] = createSignal<Snapshot>();
  const [following, setFollowing] = createSignal(true);
  const [selected, setSelected] = createSignal('');
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  const [asking, setAsking] = createSignal(false);
  const [comparisonOpen, setComparisonOpen] = createSignal(false);
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  const [focusRoot, setFocusRoot] = createSignal<string>();
  const [locateRequest, setLocateRequest] = createSignal(0);
  const [removal, setRemoval] = createSignal<Removal>();
  const reducedMotion = createReducedMotion();
  const workingId = createMemo(() => {
    if (props.sessionWorking === false) return undefined;
    const latest = props.snapshot;
    const active = latest?.activeId;
    return latest && active && recordEmphasis(latest).get(active) === 'working'
      ? active
      : undefined;
  });
  let previousKey: string | undefined;
  const projected = displayed;
  // A focused branch narrows only what the stage shows; edits still address the whole map.
  const shown = createMemo(() => {
    const view = projected();
    const rootId = focusRoot();
    return view && rootId ? branchSnapshot(view, rootId) : view;
  });
  createEffect(() => {
    const rootId = focusRoot();
    if (rootId && !projected()?.records.some((record) => record.id === rootId))
      setFocusRoot(undefined);
  });
  const focusTrail = () => {
    const view = projected();
    const rootId = focusRoot();
    return view && rootId ? nodeTrail(view.records, rootId) : [];
  };
  const recordOf = (id: string) => projected()?.records.find((r) => r.id === id);
  const selectedRecord = () => recordOf(selected());
  const explanationsFor = (id: string) =>
    projected()?.explanations?.filter((entry) => entry.nodeId === id) ?? [];
  const hasOptions = () => !!projected()?.records.some((record) => record.kind === 'option');
  const draftFor = (id: string): NoteDraft | undefined => {
    const record = recordOf(id);
    if (!record) return;
    const stored = getDraft(workspace(), id);
    if (!stored)
      return {
        title: record.title,
        detail: record.detail,
        base: { title: record.title, detail: record.detail },
        question: '',
      };
    const next = { ...stored, base: { ...stored.base } };
    // A question alone must not pin old note text after undo or adopting a report.
    for (const field of ['title', 'detail'] as const) {
      if (stored[field] === stored.base[field]) {
        next[field] = record[field];
        next.base[field] = record[field];
      }
    }
    return next;
  };
  const draft = () => draftFor(selected());
  const inline = createInlineEditing({
    label: 'Idea title',
    visible: () => props.visible && !comparisonOpen(),
    read: (id) => {
      const value = draftFor(id);
      return value && { title: value.title, base: value.base.title };
    },
    onStart: (id) => {
      select(id);
      setDetailsOpen(false);
    },
    onChange: (title) => {
      const value = draftFor(title.id);
      if (value)
        change(
          updateDraft(workspace(), title.id, {
            ...value,
            title: title.title,
            base: { ...value.base, title: title.base },
          }),
        );
    },
    onSave: (title) => {
      const current = latest();
      if (!current || saving()) return false;
      try {
        const node = current.records.find((node) => node.id === title.id);
        if (!node) throw new Error('This node is no longer available.');
        const operations = notePatch(current, title.id, {
          title: title.title,
          detail: node.detail,
          base: { title: title.base, detail: node.detail },
          question: '',
        });
        const stored = getDraft(workspace(), title.id);
        return commit(operations, {
          after: (saved) =>
            untrack(() => {
              // Leave a newer draft (typed while IPC was pending) untouched.
              if (getDraft(workspace(), title.id) !== stored) return;
              const record = saved.records.find((node) => node.id === title.id);
              if (stored && record)
                change(
                  updateDraft(workspace(), title.id, {
                    ...stored,
                    title: record.title,
                    base: { ...stored.base, title: record.title },
                  }),
                );
            }),
        });
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Could not rename node.');
        return false;
      }
    },
    onCancel: (id) => {
      const current = latest()?.records.find((node) => node.id === id);
      const value = getDraft(workspace(), id);
      if (current && value)
        change(
          updateDraft(workspace(), id, {
            ...value,
            title: current.title,
            base: { ...value.base, title: current.title },
          }),
        );
      setDisplayed(latest());
      setMessage('');
      focusNode(id);
    },
    onFinish: focusNode,
    onAdd: (id, placement) =>
      afterInlineSave(() => (placement === 'sibling' ? createSibling(id) : createChild(id))),
  });
  /** Runs after the pending render commits, unless the graph was disposed meanwhile. */
  function afterRender(action: () => void) {
    queueMicrotask(() => {
      if (!disposed) action();
    });
  }
  function focusNode(id: string, locate = false) {
    setSelected(id);
    if (locate) setLocateRequest((value) => value + 1);
    afterRender(() => {
      if (untrack(() => props.visible)) focusRecord(root, id);
    });
  }
  function nodeKeydown(id: string, event: KeyboardEvent) {
    if (
      inline.keydown(id, event) ||
      event.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      removeNode(id);
    } else if (event.key === 'Escape' && focusRoot() && !detailsOpen()) {
      // The note keeps keyboard focus; only the narrowed view goes away.
      event.preventDefault();
      event.stopPropagation();
      setFocusRoot(undefined);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeDetails(false);
      fallbackControl?.focus();
    }
  }
  function removeNode(id: string) {
    afterInlineSave(() =>
      untrack(() => {
        const current = latest();
        const record = current?.records.find((node) => node.id === id);
        if (!current || !record?.parent) return;
        if (displayed()?.revision !== current.revision) {
          setMessage('Return to the current graph before deleting a branch.');
          return;
        }
        const count = descendants(current.records, id);
        if (count) setRemoval({ record, count });
        else deleteBranch(record);
      }),
    );
  }
  function deleteBranch(record: InvestigationRecord) {
    commit([{ type: 'remove', id: record.id }], {
      failure: 'Could not delete node.',
      after: () => {
        setDetailsOpen(false);
        focusNode(record.parent ?? '');
      },
    });
  }
  function releaseToAgent(id: string) {
    commit([{ type: 'update', id, changes: {}, userEdited: [] }], {
      failure: 'Could not release the node.',
    });
  }
  function setKind(id: string, kind: MapNodeKind) {
    afterInlineSave(() =>
      untrack(() => {
        const record = latest()?.records.find((node) => node.id === id);
        if (!record || (record.kind ?? 'idea') === kind) return;
        commit(
          [
            {
              type: 'update',
              id,
              changes: {
                kind: kind === 'idea' ? null : kind,
                ...(record.confidence !== undefined && kind !== 'hypothesis'
                  ? { confidence: null }
                  : {}),
                ...(record.evaluations !== undefined && kind !== 'option'
                  ? { evaluations: null }
                  : {}),
              },
            },
          ],
          { failure: 'Could not change node type.', after: () => focusNode(id) },
        );
      }),
    );
  }
  function toggle(id: string) {
    setCollapsed((before) => {
      const next = new Set(before);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    focusNode(id);
  }
  const conflicts = () => {
    const current = latest();
    return current ? conflictFields(current, selected(), draft()) : [];
  };
  function save() {
    const current = latest(),
      value = draft();
    if (!current || !value) return;
    const id = selected(),
      stored = getDraft(workspace(), id);
    const after = (saved: Snapshot) =>
      untrack(() => {
        if (getDraft(workspace(), id) !== stored) return;
        const record = saved.records.find((node) => node.id === id);
        if (!record) return;
        const text = { title: record.title, detail: record.detail };
        change(
          updateDraft(
            workspace(),
            id,
            value.question ? { ...text, base: text, question: value.question } : undefined,
          ),
        );
      });
    try {
      commit(notePatch(current, id, value, true), { after });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save node.');
    }
  }
  function discard() {
    const value = draft(),
      current = latest();
    const restored = current?.records.find((node) => node.id === selected());
    if (!value || !restored) return;
    const text = { title: restored.title, detail: restored.detail };
    change(
      updateDraft(
        workspace(),
        selected(),
        value.question ? { ...text, base: text, question: value.question } : undefined,
      ),
    );
    setDisplayed(current);
    setMessage('');
  }
  function createChild(parent: string) {
    insertNote(childNode(parent, undefined));
  }
  /** Enter on a note adds a peer of the same kind right after it; the root only has children. */
  function createSibling(id: string) {
    const record = latest()?.records.find((node) => node.id === id);
    if (!record) return;
    if (!record.parent || focusRoot() === id) createChild(id);
    else insertNote(childNode(record.parent, record.kind), id);
  }
  function insertNote(node: InvestigationRecord, after?: string) {
    commit([{ type: 'insert', node, after }], {
      failure: 'Could not add node.',
      after: (saved) => {
        setCollapsed((old) => {
          const expanded = new Set(old);
          for (const ancestor of nodeTrail(saved.records, node.id)) expanded.delete(ancestor.id);
          return expanded;
        });
        setComparisonOpen(false);
        inline.reset();
        inline.edit(node.id);
        setLocateRequest((value) => value + 1);
      },
    });
  }
  async function ask() {
    const value = draft();
    const record = selectedRecord();
    if (!props.onAsk || !value?.question.trim() || !record || sending() || props.askBlocker) return;
    const key = props.graphKey;
    const id = selected();
    setSending(true);
    setMessage('');
    try {
      const outcome = await props.onAsk(
        { ...record, title: value.title, detail: value.detail },
        value.question,
        displayed()?.revision ?? 0,
      );
      if (stale(key)) return;
      const stored = getDraft(workspace(), id);
      const unchanged = stored?.question === value.question;
      if (unchanged) change(updateDraft(workspace(), id, { ...stored, question: '' }));
      if (selected() === id) {
        // A question typed during the send stays open in the composer.
        if (unchanged) setAsking(false);
        setMessage(
          outcome === 'queued' ? 'Queued until the agent is ready.' : 'Question sent to the agent.',
        );
      }
    } catch (error) {
      if (!stale(key) && selected() === id)
        setMessage(error instanceof Error ? error.message : 'Could not send question.');
    } finally {
      if (!stale(key)) setSending(false);
    }
  }
  function reference(id: string) {
    afterInlineSave(() =>
      untrack(() => {
        const view = projected();
        const record = view?.records.find((node) => node.id === id);
        if (record && view) props.onReference?.(record, view.revision);
      }),
    );
  }
  function requestBranch(id: string, intent: BranchRequest['intent']) {
    afterInlineSave(() =>
      untrack(() => {
        const view = projected();
        if (view)
          props.onBranchRequest?.({ intent, rootId: id, map: view, revision: view.revision });
      }),
    );
  }
  const exportSnapshot = () => {
    const snapshot = newerAvailable() ? displayed() : latest();
    const rootId = focusRoot();
    // The drawing is the focused branch, so the data exported with it is too.
    return snapshot && rootId ? branchSnapshot(snapshot, rootId) : snapshot;
  };
  function exportGraph(format: ExportFormat) {
    const snapshot = exportSnapshot();
    if (!snapshot) return;
    try {
      exportReasoningGraphAs(format, snapshot, root.querySelector('.investigation-svg'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not export the graph.');
    }
  }
  let root!: HTMLElement;
  let fallbackControl: HTMLButtonElement | undefined;

  createEffect(() => {
    const key = props.graphKey;
    const incoming = props.snapshot;
    const visible = props.visible;
    const previous = untrack(committed);
    if (previousKey === key && incoming && previous && incoming.revision > previous.revision)
      setCommitted(undefined);
    if (key !== previousKey) {
      setCommitted(undefined);
      pendingCommit = undefined;
    }
    const current = latest();
    if (key !== previousKey || !current) {
      if (key !== previousKey) {
        setLocalWorkspace(emptyWorkspace());
        history.reset();
        setMessage('');
        setSending(false);
        setSaving(false);
        setRemoval(undefined);
      }
      inline.reset();
      previousKey = key;
      setFollowing(true);
      setDisplayed(current);
      setSelected(current?.activeId ?? current?.records[0]?.id ?? '');
      setDetailsOpen(false);
      setComparisonOpen(false);
      setToolbarMenu(undefined);
      setCollapsed(new Set<string>());
      setFocusRoot(undefined);
    } else if (following() && visible && current?.revision !== untrack(displayed)?.revision) {
      setDisplayed(current);
    }
    setRendererVisible(visible);
  });
  const newerAvailable = () =>
    !following() && (latest()?.revision ?? -1) > (displayed()?.revision ?? -1);
  createEffect(() => {
    if (comparisonOpen() && !hasOptions()) setComparisonOpen(false);
  });
  createEffect(() => {
    // An agent update may remove the node being renamed. onSave then fails forever, and
    // inlineEditing refuses every other action while a draft will not save, so the whole
    // canvas — rename, add, delete, Export — would stay wedged on the lost draft.
    const live = latest()?.records;
    const draftId = untrack(inline.editing)?.id;
    if (draftId && live && !live.some((record) => record.id === draftId)) inline.reset();
  });
  createEffect(() => {
    const all = (comparisonOpen() ? projected() : shown())?.records ?? [];
    const records = comparisonOpen() ? all : visibleNodes(all, collapsed());
    const id = untrack(selected);
    if (!id || records.some((record) => record.id === id)) return;
    // The note left the graph or its branch closed; drafts stay in the workspace for later.
    if (untrack(detailsOpen)) {
      setDetailsOpen(false);
      setSelected('');
    } else setSelected(records[0]?.id ?? '');
  });
  function select(id: string) {
    setSelected(id);
    setMessage('');
  }
  function openDetails(id = selected(), ask = false) {
    // The persisted draft remains available for explicit conflict resolution in Details.
    inline.reset();
    select(id);
    setAsking(ask);
    setDetailsOpen(true);
  }
  function returnToCurrent() {
    inline.reset();
    setDisplayed(latest());
    setFollowing(true);
  }
  function focusBranch(id: string) {
    inline.reset();
    setFocusRoot(id);
    select(id);
    setLocateRequest((value) => value + 1);
  }
  /** Opens the way to a note found by search, leaving a focused branch if it lies outside. */
  function reveal(id: string) {
    const view = projected();
    if (!view) return;
    const trail = nodeTrail(view.records, id);
    setCollapsed((old) => {
      const next = new Set(old);
      for (const ancestor of trail) next.delete(ancestor.id);
      return next;
    });
    const rootId = focusRoot();
    if (rootId && !trail.some((step) => step.id === rootId)) setFocusRoot(undefined);
    setMessage('');
    focusNode(id, true);
  }
  function findCurrent() {
    const snapshot = displayed();
    const activeId = snapshot?.activeId;
    if (!snapshot || !activeId) return;
    const byId = new Map(snapshot.records.map((record) => [record.id, record]));
    const next = new Set(collapsed());
    let record = byId.get(activeId);
    while (record?.parent) {
      next.delete(record.parent);
      record = byId.get(record.parent);
    }
    setCollapsed(next);
    const rootId = focusRoot();
    if (rootId && !nodeTrail(snapshot.records, activeId).some((step) => step.id === rootId))
      setFocusRoot(undefined);
    setSelected(activeId);
    setLocateRequest((value) => value + 1);
  }
  function closeDetails(restoreFocus = true) {
    setDetailsOpen(false);
    if (!restoreFocus) return;
    const selectedId = selected();
    const attribute = comparisonOpen() ? 'data-option-id' : 'data-record-id';
    afterRender(() => {
      const node = root.querySelector<HTMLElement>(`[${attribute}="${CSS.escape(selectedId)}"]`);
      (node?.getClientRects().length ? node : fallbackControl)?.focus();
    });
  }
  function toggleComparison(open = !comparisonOpen()) {
    inline.reset();
    setDetailsOpen(false);
    setComparisonOpen(open);
    if (!open) afterRender(() => fallbackControl?.focus());
  }
  function sectionKeydown(event: KeyboardEvent) {
    if (overlay()) return;
    const inField = !!(event.target as Element).closest('input, textarea');
    if (!event.isComposing && !inField && (event.ctrlKey || event.metaKey)) {
      if (event.key.toLowerCase() !== 'z') return;
      event.preventDefault();
      event.stopPropagation();
      undo(event.shiftKey);
    } else if (event.key === 'Escape' && detailsOpen()) {
      event.stopPropagation();
      closeDetails();
    } else if (event.key === 'Escape' && comparisonOpen()) {
      event.stopPropagation();
      toggleComparison(false);
    } else if (event.key === 'Escape' && focusRoot()) {
      event.stopPropagation();
      setFocusRoot(undefined);
    }
  }
  const followLabel = () =>
    following() ? 'Following' : newerAvailable() ? 'Paused · new updates' : 'Paused';
  const [toolbarMenu, setToolbarMenu] = createSignal<{
    kind: 'follow' | 'export';
    owner: HTMLButtonElement;
    anchor: { x: number; y: number };
  }>();
  function closeToolbarMenu() {
    const owner = toolbarMenu()?.owner;
    setToolbarMenu(undefined);
    owner?.focus({ preventScroll: true });
  }
  function openToolbarMenu(kind: 'follow' | 'export', owner: HTMLButtonElement) {
    if (toolbarMenu()?.kind === kind) {
      closeToolbarMenu();
      return;
    }
    const bounds = owner.getBoundingClientRect();
    setToolbarMenu({ kind, owner, anchor: { x: bounds.left, y: bounds.bottom + 4 } });
  }
  createEffect(() => {
    if (!props.visible || overlay() || !projected()) setToolbarMenu(undefined);
  });
  const exportActions = (): NodeAction[] =>
    exportFormats.map((entry) => ({
      label: entry.label,
      title: entry.hint,
      run: () => exportGraph(entry.format),
    }));
  const followActions = (): NodeAction[] => [
    { label: 'Follow updates', checked: following(), run: returnToCurrent },
    { label: 'Pause updates', checked: !following(), run: () => setFollowing(false) },
  ];
  function nodeActions(id: string, snapshot: Snapshot): NodeAction[] {
    const record = snapshot.records.find((node) => node.id === id);
    const isRoot = !record?.parent;
    // A focused branch root has no visible siblings; Enter adds a child instead.
    const actsAsRoot = isRoot || focusRoot() === id;
    return [
      { label: 'Rename', shortcut: 'F2', icon: PencilIcon, run: () => inline.edit(id) },
      { label: 'Edit details', icon: InfoIcon, run: () => openDetails(id) },
      {
        label: 'Node type',
        disabled: saving(),
        children: mapNodeKinds.map((kind) => ({
          label: kind === 'idea' ? 'Plain' : noteTypes[kind].label,
          checked: (record?.kind ?? 'idea') === kind,
          run: () => setKind(id, kind),
        })),
      },
      {
        label: 'Add child node',
        shortcut: 'Tab',
        separator: true,
        icon: PlusIcon,
        run: () => afterInlineSave(() => untrack(() => createChild(id))),
      },
      {
        label: 'Add sibling node',
        shortcut: 'Enter',
        icon: PlusIcon,
        disabled: actsAsRoot,
        run: () => afterInlineSave(() => untrack(() => createSibling(id))),
      },
      {
        label: collapsed().has(id) ? 'Expand branch' : 'Collapse branch',
        disabled: !snapshot.records.some((node) => node.parent === id),
        run: () => toggle(id),
      },
      {
        label: focusRoot() === id ? 'Show whole map' : 'Focus on this branch',
        disabled: isRoot,
        run: () => (focusRoot() === id ? setFocusRoot(undefined) : focusBranch(id)),
      },
      ...agentNodeActions(id, record),
      ...(props.taskActions?.(id, snapshot) ?? []),
      {
        label: 'Delete node',
        shortcut: 'Del',
        separator: true,
        danger: true,
        icon: TrashIcon,
        disabled: isRoot,
        run: () => removeNode(id),
      },
    ];
  }
  /** Two ask flows: a question about one note, or a branch handed to the chat composer. */
  function agentNodeActions(id: string, record?: InvestigationRecord): NodeAction[] {
    const actions: NodeAction[] = [];
    if (props.onAsk)
      actions.push({
        label: 'Ask about this node…',
        icon: CommentIcon,
        run: () => openDetails(id, true),
      });
    if (props.onBranchRequest)
      // eslint-disable-next-line solid/reactivity -- invoked by the menu; read the current view at selection time
      actions.push(branchAgentAction((intent) => requestBranch(id, intent)));
    if (props.onReference)
      actions.push({ label: 'Reference in chat', icon: MentionIcon, run: () => reference(id) });
    if (store.canvasOwnershipBadges && record?.userEdited?.length)
      actions.push({
        label: 'Release to agent',
        title: 'Let the agent edit or remove this node again',
        icon: PersonIcon,
        run: () => releaseToAgent(id),
      });
    if (actions.length) actions[0] = { ...actions[0], separator: true };
    return actions;
  }

  return (
    <section
      ref={root}
      class="investigation reasoning-graph"
      aria-label="Reasoning graph"
      data-drafting={!!props.drafting}
      onKeyDown={sectionKeydown}
    >
      <div class="reasoning-graph-toolbar" role="group" aria-label="Graph controls">
        <div class="reasoning-graph-status">{props.controls}</div>
        <fieldset class="reasoning-graph-actions" disabled={!projected() || !!overlay()}>
          <GraphSearch
            records={projected()?.records ?? []}
            kindLabel={(node) => (node.kind ? noteTypes[node.kind].label : undefined)}
            onPick={reveal}
          />
          <button
            ref={fallbackControl}
            aria-haspopup="menu"
            aria-expanded={toolbarMenu()?.kind === 'follow'}
            classList={{ 'reasoning-graph-update': newerAvailable() }}
            title="Choose whether to follow the agent’s latest updates"
            onClick={(event) => openToolbarMenu('follow', event.currentTarget)}
          >
            {followLabel()}
            <span aria-hidden="true"> ▾</span>
          </button>
          <button
            aria-label="Undo"
            title="Undo"
            disabled={saving() || !history.canUndo()}
            onClick={() => undo()}
          >
            <UndoIcon />
          </button>
          <button
            aria-label="Redo"
            title="Redo"
            disabled={saving() || !history.canRedo()}
            onClick={() => undo(true)}
          >
            <RedoIcon />
          </button>
          <Show when={comparisonOpen() || hasOptions()}>
            <button aria-pressed={comparisonOpen()} onClick={() => toggleComparison()}>
              {comparisonOpen() ? 'Show graph' : 'Compare options'}
            </button>
          </Show>
          <button
            aria-label="Export graph"
            title={comparisonOpen() ? 'Show the graph to export it' : 'Save the current graph'}
            disabled={!projected()?.records.length || !!inline.editing() || comparisonOpen()}
            aria-haspopup="menu"
            aria-expanded={toolbarMenu()?.kind === 'export'}
            onClick={(event) => openToolbarMenu('export', event.currentTarget)}
          >
            <DownloadIcon /> Export <span aria-hidden="true">▾</span>
          </button>
          <span class="reasoning-graph-extra">{props.actions}</span>
        </fieldset>
      </div>
      <Show when={toolbarMenu()} keyed>
        {(menu) => (
          <NodeContextMenu
            anchor={menu.anchor}
            owner={menu.owner}
            label={menu.kind === 'follow' ? 'Follow updates' : 'Export format'}
            actions={menu.kind === 'follow' ? followActions() : exportActions()}
            onClose={closeToolbarMenu}
          />
        )}
      </Show>
      {props.notices}
      <div class="reasoning-graph-body">
        {overlay()}
        <div class="reasoning-graph-frame" inert={!!overlay()}>
          <Show when={message() && !detailsOpen()}>
            <p class="reasoning-inline-message" role="alert">
              {message()}
            </p>
          </Show>
          <Show
            when={projected()}
            fallback={
              <div class="reasoning-graph-empty" role="status" aria-busy={!!props.loading}>
                <Show when={props.loading} fallback="No reasoning graph available for this task">
                  <span class="inline-spinner" aria-hidden="true" />
                  <span>Waiting for the agent’s first update…</span>
                </Show>
              </div>
            }
          >
            {(snapshot) => (
              <div class="investigation-workspace">
                <section
                  class="investigation-stage"
                  style={{ display: comparisonOpen() ? 'none' : undefined }}
                >
                  <Show when={focusTrail().length}>
                    <nav class="reasoning-graph-breadcrumb" aria-label="Focused branch">
                      <button type="button" onClick={() => setFocusRoot(undefined)}>
                        Whole map
                      </button>
                      <Index each={focusTrail().slice(1, -1)}>
                        {(step) => (
                          <>
                            <span aria-hidden="true">›</span>
                            <button type="button" onClick={() => focusBranch(step().id)}>
                              {step().title || 'Untitled'}
                            </button>
                          </>
                        )}
                      </Index>
                      <span aria-hidden="true">›</span>
                      <span aria-current="location">
                        {focusTrail().at(-1)?.title || 'Untitled'}
                      </span>
                    </nav>
                  </Show>
                  <Show when={props.graphKey} keyed>
                    <InvestigationGraph
                      snapshot={shown() ?? snapshot()}
                      selected={selected()}
                      locateId={selected()}
                      collapsed={collapsed()}
                      follow={following()}
                      reducedMotion={reducedMotion()}
                      pulseWork={!!snapshot().activeId && snapshot().activeId === workingId()}
                      visible={rendererVisible() && !comparisonOpen()}
                      defaultZoom={props.defaultZoom}
                      locateRequest={locateRequest()}
                      dimUnselected={false}
                      dimUnconnected
                      showOwnership={store.canvasOwnershipBadges}
                      changeKey={`${props.graphKey}:${focusRoot() ?? ''}`}
                      editingId={inline.editing()?.id}
                      renderEditor={inline.renderEditor}
                      renderNodeExtra={(id) => (
                        <>
                          {props.renderTaskBadge?.(id)}
                          {/* Counts stay off resting cards; the selected note shows them. */}
                          <Show when={selected() === id && recordOf(id)}>
                            {(record) => (
                              <NodeBadges record={record()} explanations={explanationsFor(id)} />
                            )}
                          </Show>
                        </>
                      )}
                      renderNodeActions={(id) => (
                        <button
                          tabIndex={-1}
                          title="Add child node"
                          aria-label="Add child node"
                          onClick={() => afterInlineSave(() => untrack(() => createChild(id)))}
                        >
                          <PlusIcon size={12} />
                        </button>
                      )}
                      onEdit={inline.edit}
                      onNodeKeyDown={nodeKeydown}
                      nodeActions={(id) => nodeActions(id, snapshot())}
                      onToggle={toggle}
                      onSelect={select}
                      onClearSelection={() => {
                        inline.reset();
                        setSelected('');
                        setDetailsOpen(false);
                      }}
                      onHold={() => {}}
                      onFindCurrent={findCurrent}
                    />
                  </Show>
                </section>
                <Show when={comparisonOpen()}>
                  <OptionsComparison snapshot={snapshot()} onSelect={openDetails} />
                </Show>
                <Show when={detailsOpen()}>
                  <InvestigationInspector
                    snapshot={snapshot()}
                    selected={selected()}
                    draft={draft()}
                    userCreated={!!selectedRecord()?.userEdited?.includes('*')}
                    edited={!!selectedRecord()?.userEdited?.length}
                    conflicts={conflicts()}
                    latestRecord={latest()?.records.find((r) => r.id === selected())}
                    onDraft={(draft) => {
                      setMessage('');
                      change(updateDraft(workspace(), selected(), draft));
                    }}
                    onSave={save}
                    onDiscard={discard}
                    onAsk={props.onAsk ? ask : undefined}
                    asking={asking()}
                    onAskingChange={setAsking}
                    askBlocker={props.askBlocker}
                    sending={sending()}
                    saving={saving()}
                    message={message()}
                    onOpenSource={props.onOpenSource}
                    onCheckSource={props.onCheckSource}
                    onJumpToTranscript={props.onJumpToTranscript}
                    onRemoveExplanation={(id) =>
                      commit([{ type: 'remove_explanation', id }], {
                        failure: 'Could not remove the answer.',
                      })
                    }
                    onSelect={openDetails}
                    onClose={closeDetails}
                  />
                </Show>
              </div>
            )}
          </Show>
        </div>
      </div>
      <ConfirmDialog
        open={!!removal()}
        title="Delete this branch?"
        message={`“${removal()?.record.title ?? ''}” and ${removal()?.count ?? 0} connected ${
          removal()?.count === 1 ? 'node' : 'nodes'
        } will be removed. You can undo this afterwards.`}
        confirmLabel="Delete branch"
        danger
        onConfirm={() => {
          const pending = removal();
          setRemoval(undefined);
          if (pending) deleteBranch(pending.record);
        }}
        onCancel={() => {
          const pending = removal();
          setRemoval(undefined);
          if (pending) focusNode(pending.record.id);
        }}
      />
    </section>
  );
}
