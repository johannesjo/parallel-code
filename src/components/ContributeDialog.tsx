import { For, Show, createEffect, createSignal, createUniqueId } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { errMessage } from '../lib/log';
import {
  CONTRIBUTING_URL,
  FORK_COMMAND,
  UPSTREAM_REPOSITORY,
  findParallelCodeProject,
} from '../store/contribute';
import { store } from '../store/core';
import { openGitHubIssuesWithLabel } from '../store/github';
import { pickAndAddProject } from '../store/projects';
import { Dialog } from './Dialog';
import { DialogCloseButton } from './DialogCloseButton';
import { ExternalLinkIcon, PersonIcon, SparkleIcon } from './icons';
import './contribute-dialog.css';

const LABELS = [
  {
    label: 'good first issue',
    text: 'Good first issues',
    description: 'Small, well-scoped places to start',
    icon: SparkleIcon,
  },
  {
    label: 'help wanted',
    text: 'Help wanted',
    description: 'Issues the maintainers would like help with',
    icon: PersonIcon,
  },
];

const STEPS = [
  'Pick an upstream issue',
  'Work on it as a task, like any other',
  'Finish opens a pull request from your fork',
];

/**
 * Entry into contributing: opens the upstream issues, filtered to a beginner
 * label, in the project that is a checkout of Parallel Code. Picking one starts
 * a normal task, and its pull request goes through the usual finish flow.
 */
export function ContributeDialog(props: { open: boolean; onClose: () => void }) {
  const titleId = createUniqueId();
  const [busy, setBusy] = createSignal(false);
  // The label asked for while no checkout exists, so adding one can continue.
  const [missingFor, setMissingFor] = createSignal<string | null>(null);
  const [lookupError, setLookupError] = createSignal<string | null>(null);
  const [addError, setAddError] = createSignal<string | null>(null);

  // Each opening starts from the label buttons, not a previous attempt's hints.
  // Bumped on close, so a lookup still running then cannot act on a later opening.
  let opening = 0;
  createEffect(() => {
    if (props.open) return;
    opening++;
    setMissingFor(null);
    setLookupError(null);
    setAddError(null);
  });

  async function browse(label: string) {
    const run = opening;
    setBusy(true);
    try {
      const { project, lookupError } = await findParallelCodeProject(store.projects);
      if (run !== opening) return;
      setMissingFor(project ? null : label);
      setLookupError(lookupError);
      if (!project) return;
      props.onClose();
      openGitHubIssuesWithLabel(project.id, label);
    } finally {
      setBusy(false);
    }
  }

  async function addCheckout(label: string) {
    const run = opening;
    setAddError(null);
    try {
      if ((await pickAndAddProject()) && run === opening) await browse(label);
    } catch (err) {
      setAddError(`Could not add the project: ${errMessage(err)}`);
    }
  }

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      width="500px"
      labelledBy={titleId}
      panelStyle={{ gap: '18px' }}
    >
      <header class="contribute-header">
        <div>
          <h2 id={titleId} class="contribute-title">
            Contribute to Parallel Code
          </h2>
          <p class="contribute-subtitle">Open source on GitHub · {UPSTREAM_REPOSITORY}</p>
        </div>
        <DialogCloseButton label="Close contribute" onClick={() => props.onClose()} />
      </header>

      <ol class="contribute-steps">
        <For each={STEPS}>{(step) => <li>{step}</li>}</For>
      </ol>

      <div class="contribute-choices">
        <For each={LABELS}>
          {(item) => (
            <button
              type="button"
              class="contribute-choice"
              disabled={busy()}
              onClick={() => void browse(item.label)}
            >
              <span class="contribute-choice-title">
                <item.icon size={14} />
                {item.text}
              </span>
              <span class="contribute-choice-desc">{item.description}</span>
            </button>
          )}
        </For>
      </div>

      <Show when={missingFor()}>
        {(label) => (
          <div role="status" class="contribute-missing">
            <p class="contribute-missing-title">No checkout of Parallel Code yet</p>
            <p class="contribute-hint">Fork and clone it, then add the folder as a project:</p>
            <pre class="contribute-command">
              <code>{FORK_COMMAND}</code>
            </pre>
            <p class="contribute-hint">
              A fork you already have needs an <code>upstream</code> remote that points at{' '}
              {UPSTREAM_REPOSITORY}.
            </p>
            <Show when={lookupError()}>
              {(error) => (
                <p class="contribute-hint">
                  GitHub CLI could not check your projects ({error()}), so the checkout may be one
                  of them.
                </p>
              )}
            </Show>
            <div>
              <button
                type="button"
                class="btn-secondary contribute-add"
                disabled={busy()}
                onClick={() => void addCheckout(label())}
              >
                Add project…
              </button>
            </div>
            <Show when={addError()}>
              {(error) => (
                <p role="alert" class="contribute-hint contribute-error">
                  {error()}
                </p>
              )}
            </Show>
          </div>
        )}
      </Show>

      <footer class="contribute-footer">
        <a
          href={CONTRIBUTING_URL}
          class="contribute-guide"
          onClick={(e) => {
            e.preventDefault();
            void invoke(IPC.ShellOpenExternal, { url: CONTRIBUTING_URL });
          }}
        >
          Contributing guide
          <ExternalLinkIcon size={11} />
        </a>
        <span class="contribute-hint">
          Plain clone? Run <code>gh repo fork --remote</code> first.
        </span>
      </footer>
    </Dialog>
  );
}
