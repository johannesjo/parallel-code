import { For, Show, createMemo, createSignal, onCleanup } from 'solid-js';
import { documentAgentSupport } from '../../electron/documents/shared';
import { errMessage } from '../lib/log';
import { store } from '../store/core';
import { getProject } from '../store/projects';
import {
  documentMainAgentId,
  documentModelChoices,
  documentStore,
  mergeDocumentCandidates,
  modelLabel,
} from './store';
import type { DocumentRunRecord } from './types';
import { registerCompareForm } from './workspace-ui';

const DEFAULT_GUIDANCE =
  'Combine the strongest parts of each candidate into one version. Keep the document’s voice, ' +
  'and where candidates conflict prefer the clearer wording over the more complete one.';

/**
 * Hands the reviewing to an agent: it reads the chosen proposals as diffs
 * against the base and drafts one merged proposal, which lands in Runs like
 * any other and is never accepted on its own.
 */
export function MergeWithAgent(props: {
  run: DocumentRunRecord;
  /** Names the agent behind each proposal; off, the review stays model-blind. */
  revealAgents: boolean;
  onClose: () => void;
}) {
  const project = () => (documentStore.projectId ? getProject(documentStore.projectId) : undefined);
  const agents = createMemo(() =>
    store.availableAgents.filter(
      (a) => a.available !== false && documentAgentSupport(a.id).headless,
    ),
  );
  const [agentId, setAgentId] = createSignal<string | null>(null);
  const agent = () =>
    agents().find((a) => a.id === (agentId() ?? documentMainAgentId(project()))) ?? agents()[0];
  const mergeable = createMemo(() =>
    props.run.candidates.filter((c) => c.status === 'done' && c.commitSha),
  );
  // Excluded rather than included: every proposal is in until the reviewer drops it.
  const [excluded, setExcluded] = createSignal<ReadonlySet<string>>(new Set<string>());
  const chosen = () => mergeable().filter((c) => !excluded().has(c.id));
  const [guidance, setGuidance] = createSignal(DEFAULT_GUIDANCE);
  const [starting, setStarting] = createSignal(false);
  const [error, setError] = createSignal('');
  const ready = () => !!agent() && chosen().length >= 2 && !!guidance().trim() && !starting();

  function toggleCandidate(id: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  async function merge() {
    const picked = agent();
    if (!picked || !ready()) return;
    setStarting(true);
    setError('');
    try {
      await mergeDocumentCandidates({
        run: props.run,
        candidateIds: chosen().map((c) => c.id),
        instruction: guidance().trim(),
        agent: picked,
        choice: documentModelChoices(project(), picked.id)[0] ?? {},
      });
      props.onClose();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setStarting(false);
    }
  }

  // Mounted only while open, so the form is registered for its whole life.
  // eslint-disable-next-line solid/reactivity -- the registry calls back later, outside any reactive context; it wants the current onClose
  onCleanup(registerCompareForm(() => props.onClose()));

  // Bound natively so the key stops here: the compare dialog listens on the
  // document and would take the same Escape as its own and close over the form.
  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    props.onClose();
  }

  return (
    <section class="docws-merge-panel" aria-label="Merge with agent" on:keydown={onKeyDown}>
      <p>
        One agent reads the proposals you pick, as diffs against the base, and drafts a single
        merged proposal. It shows up in Runs for you to review; nothing is accepted for you.
      </p>
      <div class="docws-merge-row" role="group" aria-label="Proposals to merge">
        <For each={mergeable()}>
          {(candidate) => (
            <label class="docws-toggle">
              <input
                type="checkbox"
                checked={!excluded().has(candidate.id)}
                onChange={() => toggleCandidate(candidate.id)}
                disabled={starting()}
              />
              Candidate {candidate.label}
              {props.revealAgents ? ` · ${candidate.agentName}` : ''}
            </label>
          )}
        </For>
      </div>
      <div class="docws-agent-row" role="group" aria-label="Merging agent">
        <For each={agents()}>
          {(a) => (
            <button
              type="button"
              class="docws-agent-chip"
              aria-pressed={agent()?.id === a.id}
              title={modelLabel(documentModelChoices(project(), a.id)[0] ?? {}) || 'CLI defaults'}
              onClick={() => setAgentId(a.id)}
              disabled={starting()}
            >
              {a.name}
            </button>
          )}
        </For>
      </div>
      <textarea
        class="docws-note"
        aria-label="Merge guidance"
        ref={(el) => queueMicrotask(() => el.focus())}
        value={guidance()}
        onInput={(e) => setGuidance(e.currentTarget.value)}
        disabled={starting()}
      />
      <Show when={error()}>
        <p class="docws-error" role="alert">
          {error()}
        </p>
      </Show>
      <div class="docws-run-actions">
        <button
          type="button"
          class="docws-btn docws-btn-sm docws-btn-primary"
          disabled={!ready()}
          title={chosen().length < 2 ? 'Pick at least two proposals' : undefined}
          onClick={() => void merge()}
        >
          {starting() ? 'Starting…' : 'Generate merged version'}
        </button>
        <button type="button" class="docws-btn docws-btn-sm" onClick={() => props.onClose()}>
          Cancel
        </button>
      </div>
    </section>
  );
}
