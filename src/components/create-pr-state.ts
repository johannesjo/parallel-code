import { createEffect, createSignal, on, untrack } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import type { PrDraft } from '../../electron/shared/pr-draft';
import type { BranchPrDetectionResult, CommitInfo, RemoteBranchState } from '../ipc/types';
import { invoke } from '../lib/ipc';
import { errMessage, warn as logWarn } from '../lib/log';
import { createPullRequestForTask, linkPullRequestToTask } from '../store/github';
import { readPrTemplate } from '../store/pr-draft';
import type { Task } from '../store/types';
import { createPrDrafting } from './create-pr-drafting';
import type { PushRun } from './push-run';
import { buildSquashMessage } from './squash-message';

export interface CreatePrStateProps {
  open: boolean;
  task: Task;
  base: string;
  /** The branch on origin, 'none' without an origin, undefined while unknown. */
  remote: RemoteBranchState | 'none' | undefined;
  commits: CommitInfo[] | undefined;
  /** Finish's push, so a push started here shows and survives there too. */
  push: PushRun;
  onCreated: (pr: { url: string; existed: boolean; draft: boolean }) => void;
}

/** Why gh cannot be used at all; the dialog says so before anything is written. */
const UNAVAILABLE = {
  missing: 'GitHub CLI (gh) was not found. Install it to create pull requests from here.',
  auth: 'GitHub CLI is not logged in. Run "gh auth login" in a terminal, then reopen this dialog.',
  // Opened by the shortcut or menu; Finish itself offers no PR without an origin.
  none: 'This branch has no origin remote to open a pull request on.',
} as const;

/** The Create pull request dialog's state: fields, the optional draft, and push-then-create. */
export function createPrState(props: CreatePrStateProps) {
  const [title, setTitle] = createSignal('');
  const [titleEdited, setTitleEdited] = createSignal(false);
  const [body, setBody] = createSignal('');
  const [bodyEdited, setBodyEdited] = createSignal(false);
  const [draft, setDraft] = createSignal(true);
  const [stage, setStage] = createSignal<'push' | 'create' | null>(null);
  const [error, setError] = createSignal('');
  const [ghUnavailable, setGhUnavailable] = createSignal('');
  const unavailable = () => {
    if (props.remote === 'none') return UNAVAILABLE.none;
    // gh would refuse it only after the push; Finish says "Nothing to merge" too.
    if (props.commits?.length === 0)
      return `This branch has no commits beyond ${props.base} yet. Commit the changes, then create the pull request.`;
    return ghUnavailable();
  };
  const [existingUrl, setExistingUrl] = createSignal<string | null>(null);
  let template: string | undefined;

  function applyDraft(result: PrDraft, requested: boolean): void {
    if (!untrack(titleEdited)) setTitle(result.title);
    if (!requested && untrack(bodyEdited)) return;
    setBody(result.body);
    setBodyEdited(false);
  }
  const drafting = createPrDrafting({ props, template: () => template, apply: applyDraft });

  function reset(): void {
    drafting.stop();
    drafting.clearError();
    template = undefined;
    setTitle(buildSquashMessage(props.commits ?? [], props.task.name).title);
    setTitleEdited(false);
    setBody('');
    setBodyEdited(false);
    setError('');
    setGhUnavailable('');
    setExistingUrl(null);
  }

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return drafting.stop();
        // A create still running from the last visit keeps its fields.
        if (untrack(stage)) return;
        reset();
        drafting.applyPending();
        preflight(props.task);
        void loadTemplate(props.task.worktreePath);
      },
    ),
  );
  // Commits arrive after the dialog opens; one commit's subject makes the better title.
  createEffect(
    on(
      () => props.commits,
      (commits) => {
        if (!commits || untrack(titleEdited) || untrack(stage)) return;
        setTitle(
          buildSquashMessage(
            commits,
            untrack(() => props.task.name),
          ).title,
        );
      },
    ),
  );

  async function loadTemplate(worktreePath: string): Promise<void> {
    template = await readPrTemplate(worktreePath);
    if (template && !untrack(bodyEdited) && !untrack(body)) setBody(template);
  }

  /** Learns before anything is written whether gh works and the branch already has a PR. */
  function preflight(task: Task): void {
    invoke<BranchPrDetectionResult>(IPC.DetectPrForBranch, {
      worktreePath: task.worktreePath,
      branchName: task.branchName,
    })
      .then((result) => {
        if (result.unavailable) setGhUnavailable(UNAVAILABLE[result.unavailable]);
        else setExistingUrl(result.url);
      })
      // Creating reports gh's own error; the preflight only saves a wasted draft.
      .catch((err: unknown) =>
        logWarn('github', 'PR preflight failed', { error: errMessage(err) }),
      );
  }

  function editTitle(value: string): void {
    setTitle(value);
    setTitleEdited(true);
  }
  /** Typing takes over from a running draft. */
  function editBody(value: string): void {
    drafting.stop();
    setBody(value);
    setBodyEdited(true);
  }

  // `differs` may be a diverged branch; the push then fails with git's reason.
  const needsPush = () => props.remote === 'unpushed' || props.remote === 'differs';

  async function submit(): Promise<void> {
    drafting.stop();
    setError('');
    if (needsPush()) {
      setStage('push');
      if (!(await props.push.start())) {
        setError(`Push failed: ${props.push.error()}`);
        setStage(null);
        return;
      }
    }
    setStage('create');
    const isDraft = draft();
    try {
      const pr = await createPullRequestForTask(props.task.id, {
        base: props.base,
        title: title().trim(),
        body: body(),
        draft: isDraft,
      });
      props.onCreated({ ...pr, draft: isDraft });
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setStage(null);
    }
  }

  /** Links the branch's existing PR instead of creating one. */
  function useExisting(): void {
    const url = existingUrl();
    if (!url) return;
    linkPullRequestToTask(props.task.id, url);
    props.onCreated({ url, existed: true, draft: false });
  }

  return {
    title,
    editTitle,
    body,
    editBody,
    draft,
    setDraft,
    drafting,
    stage,
    error,
    unavailable,
    existingUrl,
    needsPush,
    submit,
    useExisting,
  };
}
