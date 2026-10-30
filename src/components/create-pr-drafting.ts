import { createEffect, createSignal, on, onCleanup, untrack } from 'solid-js';
import type { PrDraft } from '../../electron/shared/pr-draft';
import { BRIEF_MODELS, type BriefModelId } from '../../electron/shared/task-name-model';
import type { CommitInfo } from '../ipc/types';
import { errMessage } from '../lib/log';
import { store } from '../store/core';
import {
  agentDraftBlocker,
  agentPrDraft,
  requestAgentPrDraft,
  startPrDraft,
  takeAgentPrDraft,
  type PrDraftRequest,
} from '../store/pr-draft';
import { isAgentIdle } from '../store/taskStatus';
import type { Task } from '../store/types';

/** Who writes the draft: the task's own agent, or a separate model. */
export type DraftSource = 'agent' | BriefModelId;

interface DraftingOptions {
  props: { open: boolean; task: Task; base: string; commits: CommitInfo[] | undefined };
  template: () => string | undefined;
  /** Fills the fields; a draft the user asked for replaces a description they typed. */
  apply: (draft: PrDraft, requested: boolean) => void;
}

/**
 * The optional draft of a PR title and description: by the task's agent, which
 * answers through `pr_draft_publish`, or by a separate model. The agent is the
 * default while it can take the request; busy or without the app's tools, a
 * separate model is.
 */
export function createPrDrafting({ props, template, apply }: DraftingOptions) {
  const [picked, setPicked] = createSignal<DraftSource | null>(null);
  const [drafting, setDrafting] = createSignal<DraftSource | null>(null);
  const [error, setError] = createSignal('');
  const agentBlocker = () => agentDraftBlocker(props.task.id);
  const agentName = () => {
    const id = props.task.agentIds[0];
    return (id && store.agents[id]?.def?.name) || 'The agent';
  };
  const source = (): DraftSource => {
    const choice = picked();
    if (choice && choice !== 'agent') return choice;
    return agentBlocker() ? store.briefModel : 'agent';
  };
  const sourceLabel = (from: DraftSource) =>
    from === 'agent' ? agentName() : BRIEF_MODELS[from].label;
  let request: PrDraftRequest | null = null;
  let agentWorked = false;

  /** Stops a model run, or stops waiting for the agent; a late agent draft fills only untouched fields. */
  function stop(): void {
    request?.cancel();
    request = null;
    setDrafting(null);
  }
  onCleanup(stop);

  function start(): void {
    const from = source();
    stop();
    setError('');
    setDrafting(from);
    if (from === 'agent') void askAgent();
    else draftWithModel(from);
  }

  async function askAgent(): Promise<void> {
    agentWorked = false;
    try {
      await requestAgentPrDraft(props.task.id, props.base);
    } catch (err) {
      if (untrack(drafting) !== 'agent') return;
      setError(errMessage(err));
      setDrafting(null);
    }
  }

  function draftWithModel(model: BriefModelId): void {
    const current = startPrDraft(props.task, {
      commits: props.commits ?? [],
      template: template(),
      model,
    });
    request = current;
    current.result
      .then(
        (result) => request === current && apply(result, true),
        (err: unknown) => request === current && setError(errMessage(err)),
      )
      .finally(() => {
        if (request !== current) return;
        request = null;
        setDrafting(null);
      });
  }

  /** Fills the fields with a draft the agent published while the dialog was closed. */
  function applyPending(): void {
    const pending = takeAgentPrDraft(props.task.id);
    if (pending) apply(pending, false);
  }

  createEffect(
    on(
      () => agentPrDraft(props.task.id),
      (published) => {
        // A closed dialog leaves it waiting for the next open.
        if (!published || !props.open) return;
        takeAgentPrDraft(props.task.id);
        const requested = untrack(drafting) === 'agent';
        if (requested) setDrafting(null);
        apply(published, requested);
      },
    ),
  );
  // The agent's turn ended without the tool call, so nothing will arrive.
  createEffect(
    on(
      () => {
        const id = props.task.agentIds[0];
        return !!id && isAgentIdle(id);
      },
      (idle) => {
        if (untrack(drafting) !== 'agent') return;
        if (!idle) agentWorked = true;
        else if (agentWorked) {
          setDrafting(null);
          setError(`${untrack(agentName)} finished without publishing a draft.`);
        }
      },
    ),
  );

  return {
    source,
    pick: setPicked,
    sourceLabel,
    agentName,
    agentBlocker,
    drafting,
    error,
    clearError: () => setError(''),
    start,
    stop,
    applyPending,
  };
}

export type PrDrafting = ReturnType<typeof createPrDrafting>;
