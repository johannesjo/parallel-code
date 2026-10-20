import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onMount,
  Show,
  untrack,
  type JSX,
} from 'solid-js';
import { notePresentation, recordTrail } from './presentation';
import { KindMark } from '../graph/KindMark';
import {
  CommentIcon,
  CopyIcon,
  ExternalLinkIcon,
  SendIcon,
  TerminalIcon,
  TrashIcon,
  UndoIcon,
} from '../components/icons';
import type { InvestigationRecord, InvestigationSource, Snapshot } from './state';
import type { NoteDraft } from './editing';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';

interface Props {
  snapshot: Snapshot;
  selected: string;
  onSelect: (id: string) => void;
  onClose: (restoreFocus?: boolean) => void;
  draft?: NoteDraft;
  conflicts?: string[];
  latestRecord?: InvestigationRecord;
  edited?: boolean;
  userCreated?: boolean;
  onDraft?: (draft: NoteDraft) => void;
  onSave?: () => void;
  onDiscard?: () => void;
  onAsk?: () => Promise<void>;
  /** Controlled question form; omit to let the card manage it. */
  asking?: boolean;
  onAskingChange?: (open: boolean) => void;
  askBlocker?: string;
  sending?: boolean;
  saving?: boolean;
  message?: string;
  /** Host-specific footer content, rendered after the note details. */
  children?: JSX.Element;
  /** Opens a task file source in the app; URL sources always open externally. */
  onOpenSource?: (source: InvestigationSource) => Promise<void>;
  /** Resolves false when a task-relative source file is missing; undefined when unknown. */
  onCheckSource?: (source: InvestigationSource) => Promise<boolean | undefined>;
  /** Scrolls the agent terminal to the update that produced this note; false when none is anchored. */
  onJumpToTranscript?: (recordId: string) => boolean;
  onRemoveExplanation?: (id: string) => void;
}

export function InvestigationInspector(props: Props) {
  const record = () => props.snapshot.records.find((r) => r.id === props.selected);
  let panel!: HTMLElement;
  const [localAsking, setLocalAsking] = createSignal(false);
  const asking = () => props.asking ?? localAsking();
  const setAsking = (open: boolean) =>
    props.onAskingChange ? props.onAskingChange(open) : setLocalAsking(open);
  const dirty = () =>
    !!props.draft &&
    (props.draft.title !== props.draft.base.title ||
      props.draft.detail !== props.draft.base.detail);
  createEffect(
    on(
      () => props.selected,
      () => {
        if (props.asking === undefined) setLocalAsking(!!props.draft?.question);
      },
    ),
  );
  onMount(() => panel.focus({ preventScroll: true }));
  const [sourceError, setSourceError] = createSignal('');
  const [sourceMessage, setSourceMessage] = createSignal('');
  const [jumpMessage, setJumpMessage] = createSignal('');
  createEffect(() => {
    record();
    setSourceError('');
    setSourceMessage('');
    setJumpMessage('');
  });
  const sourceLocation = (source: InvestigationSource) =>
    source.url ?? `${source.path}${source.line ? `:${source.line}` : ''}`;
  const [missing, setMissing] = createSignal<ReadonlySet<string>>(new Set<string>());
  // Agent updates replace the record object every revision; only a changed source list
  // justifies asking the main process again.
  const sourceKey = createMemo(() => JSON.stringify([props.selected, record()?.sources ?? []]));
  createEffect(
    on([sourceKey, () => props.onCheckSource], ([key, check]) => {
      const current = untrack(record);
      setMissing(new Set<string>());
      if (!current || !check) return;
      for (const source of current.sources ?? []) {
        if (source.url) continue;
        void check(source)
          .then((exists) => {
            if (exists !== false || untrack(sourceKey) !== key) return;
            setMissing((prev) => new Set(prev).add(sourceLocation(source)));
          })
          .catch(() => {
            // An unreadable checkout is not evidence that the file is missing.
          });
      }
    }),
  );
  async function openSource(source: InvestigationSource, copy = false) {
    const current = record();
    setSourceError('');
    setSourceMessage('');
    try {
      if (source.url) await invoke(IPC.ShellOpenExternal, { url: source.url });
      else if (!copy && props.onOpenSource) await props.onOpenSource(source);
      else {
        await navigator.clipboard.writeText(sourceLocation(source));
        if (record() === current) setSourceMessage('Copied task-relative file location.');
      }
    } catch (error) {
      if (record() === current)
        setSourceError(
          error instanceof Error ? error.message : 'Could not open or copy the source',
        );
    }
  }
  const relations = () =>
    props.snapshot.relations.filter(
      (r) => r.source === props.selected || r.target === props.selected,
    );
  // Displayed confidence sits next to what backs it, so an unbacked estimate is visibly bare.
  const grounding = () => {
    const linked = relations();
    const count = (kind: string) => linked.filter((r) => r.kind === kind).length;
    return {
      supports: count('supports'),
      challenges: count('challenges'),
      sources: record()?.sources?.length ?? 0,
    };
  };
  const confidenceLine = () => {
    const percent = Math.round((record()?.confidence ?? 0) * 100);
    const g = grounding();
    return `The agent's own estimate: ${percent}% · ${g.supports} supporting · ${g.challenges} challenging · ${g.sources} sources`;
  };
  const titleOf = (id: string) =>
    props.snapshot.records.find((item) => item.id === id)?.title ?? 'Removed node';
  const explanations = () =>
    props.snapshot.explanations?.filter((entry) => entry.nodeId === props.selected) ?? [];
  function removeExplanation(id: string) {
    props.onRemoveExplanation?.(id);
    // The clicked button leaves the DOM; keep keyboard focus inside the card.
    panel.focus({ preventScroll: true });
  }
  const questionForm = (title: string) => (
    <form
      class="investigation-note-question"
      onSubmit={(event) => {
        event.preventDefault();
        void props.onAsk?.();
      }}
    >
      <label class="investigation-editor-field">
        Ask about “{title}”
        <textarea
          aria-label="Question for agent"
          rows={3}
          maxLength={8000}
          value={props.draft?.question ?? ''}
          onInput={(event) =>
            props.draft && props.onDraft?.({ ...props.draft, question: event.currentTarget.value })
          }
        />
      </label>
      <small>This node’s title and notes are included with your question.</small>
      <button
        type="submit"
        class="btn-with-icon"
        disabled={props.sending || !!props.askBlocker || !props.draft?.question.trim()}
      >
        <SendIcon size={14} />
        {props.sending ? 'Sending…' : 'Send question'}
      </button>
      <Show when={props.askBlocker}>
        <p>{props.askBlocker}</p>
      </Show>
      <button type="button" onClick={() => setAsking(false)}>
        Back to details
      </button>
    </form>
  );
  return (
    <aside
      ref={panel}
      class="investigation-inspector"
      classList={{ 'investigation-note-editor': !!props.onDraft }}
      role="dialog"
      tabIndex={-1}
      aria-label="Selected record"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          props.onClose();
        }
      }}
    >
      <div class="investigation-inspector-heading">
        <span class="investigation-eyebrow">
          {asking() && props.draft ? 'ASK AGENT' : 'NODE DETAILS'}
        </span>
        <div>
          <button aria-label="Close node details" onClick={() => props.onClose()}>
            ×
          </button>
        </div>
      </div>
      <Show
        when={record()}
        fallback={
          <p>This record is not available in the displayed snapshot. Selection is retained.</p>
        }
      >
        {(r) => (
          <>
            <nav class="investigation-breadcrumbs" aria-label="Note hierarchy">
              <For each={recordTrail(props.snapshot, r().id)}>
                {(ancestor) => (
                  <button onClick={() => props.onSelect(ancestor.id)} title={ancestor.title}>
                    {ancestor.title}
                  </button>
                )}
              </For>
            </nav>
            <div
              class="investigation-note-type"
              style={{ color: `var(${notePresentation(r().kind).color})` }}
            >
              <KindMark kind={r().kind} mark={notePresentation(r().kind).mark} size={11} />{' '}
              {notePresentation(r().kind).label || 'Node'}
              <span>{props.userCreated ? 'Your node' : r().status}</span>
            </div>
            <Show when={props.message}>
              <p role="status">{props.message}</p>
            </Show>
            <Show when={asking() && props.draft}>{questionForm(r().title)}</Show>
            {/* Ask mode shows only the composer; the two card actions must not look alike. */}
            <Show when={!asking() || !props.draft}>
              <div class="investigation-editor-actions">
                <Show when={props.onAsk}>
                  <button
                    class="btn-with-icon"
                    aria-expanded={asking()}
                    onClick={() => setAsking(!asking())}
                  >
                    <CommentIcon size={14} />
                    Ask agent
                  </button>
                </Show>
                <Show when={props.onJumpToTranscript}>
                  <button
                    class="btn-with-icon"
                    onClick={() =>
                      setJumpMessage(
                        props.onJumpToTranscript?.(props.selected)
                          ? ''
                          : 'No transcript position recorded for this node.',
                      )
                    }
                  >
                    <TerminalIcon size={14} />
                    Jump to transcript
                  </button>
                </Show>
              </div>
              <Show when={jumpMessage()}>
                <p role="status">{jumpMessage()}</p>
              </Show>
              <Show
                when={props.draft && props.onDraft}
                fallback={
                  <>
                    <h2>{r().title}</h2>
                    <p>{r().detail}</p>
                  </>
                }
              >
                <label class="investigation-editor-field">
                  Title
                  <input
                    aria-label="Node title"
                    maxLength={200}
                    value={props.draft?.title ?? ''}
                    onInput={(event) =>
                      props.draft &&
                      props.onDraft?.({ ...props.draft, title: event.currentTarget.value })
                    }
                  />
                </label>
                <label class="investigation-editor-field">
                  Notes
                  <textarea
                    aria-label="Node notes"
                    rows={6}
                    maxLength={8000}
                    value={props.draft?.detail ?? ''}
                    onInput={(event) =>
                      props.draft &&
                      props.onDraft?.({ ...props.draft, detail: event.currentTarget.value })
                    }
                  />
                </label>
                <Show when={props.conflicts?.length}>
                  <div class="investigation-edit-conflict" role="status">
                    The agent updated this note’s {props.conflicts?.join(' and ')}. Your changes are
                    preserved.
                    <details>
                      <summary>Latest agent version</summary>
                      <strong>{props.latestRecord?.title}</strong>
                      <p>{props.latestRecord?.detail}</p>
                    </details>
                  </div>
                </Show>
                <div class="investigation-editor-actions investigation-save-actions">
                  <Show when={dirty() || props.conflicts?.length}>
                    <button
                      class="investigation-primary"
                      disabled={props.saving || !props.draft?.title.trim()}
                      onClick={() => {
                        props.onSave?.();
                        panel.focus({ preventScroll: true });
                      }}
                    >
                      {props.saving
                        ? 'Saving…'
                        : props.conflicts?.length
                          ? 'Keep my changes'
                          : 'Save changes'}
                    </button>
                  </Show>
                  <Show when={dirty()}>
                    <button class="btn-with-icon" onClick={() => props.onDiscard?.()}>
                      <UndoIcon size={14} />
                      Use agent version
                    </button>
                  </Show>
                </div>
                <small>
                  {dirty()
                    ? 'Draft kept when you close this card.'
                    : props.edited
                      ? 'Your saved version.'
                      : props.userCreated
                        ? 'Your node · saved with this task.'
                        : 'Edit the title or description, then save.'}
                </small>
              </Show>
              <Show when={r().kind === 'hypothesis' && r().confidence !== undefined}>
                <p
                  class="investigation-confidence"
                  classList={{
                    'investigation-confidence-bare':
                      grounding().supports + grounding().challenges === 0,
                  }}
                >
                  {confidenceLine()}
                </p>
              </Show>
              <Show when={r().criteria}>
                <details>
                  <summary>Acceptance criteria</summary>
                  <ul>
                    <For each={r().criteria}>{(criterion) => <li>{criterion}</li>}</For>
                  </ul>
                </details>
              </Show>
              <Show when={r().result}>
                <h3>Recorded result</h3>
                <p>{r().result}</p>
              </Show>
              <Show when={r().evaluations?.length}>
                <h3>Evaluation</h3>
                <dl>
                  <For each={r().evaluations}>
                    {(entry) => (
                      <>
                        <dt>{entry.criterion}</dt>
                        <dd>{entry.assessment}</dd>
                      </>
                    )}
                  </For>
                </dl>
              </Show>
              <Show when={explanations().length}>
                <details class="investigation-qa" open>
                  <summary>Q&A · {explanations().length}</summary>
                  <ul class="investigation-qa-list">
                    <For each={explanations()}>
                      {(entry) => (
                        <li>
                          <strong>{entry.question}</strong>
                          <p>{entry.answer}</p>
                          <Show when={props.onRemoveExplanation}>
                            <button
                              class="btn-with-icon"
                              aria-label={`Remove answer to “${entry.question}”`}
                              onClick={() => removeExplanation(entry.id)}
                            >
                              <TrashIcon size={12} />
                              Remove
                            </button>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </details>
              </Show>
              <Show when={r().sources?.length}>
                <details>
                  <summary>Sources · {r().sources?.length}</summary>
                  <ul class="investigation-sources">
                    <For each={r().sources}>
                      {(source) => (
                        <li>
                          <strong>{source.label}</strong>
                          <code>{sourceLocation(source)}</code>
                          <Show when={missing().has(sourceLocation(source))}>
                            <span class="investigation-source-missing" role="status">
                              Missing file
                            </span>
                          </Show>
                          <span class="investigation-source-actions">
                            <Show when={source.url || props.onOpenSource}>
                              <button class="btn-with-icon" onClick={() => void openSource(source)}>
                                <ExternalLinkIcon size={12} />
                                {source.url ? 'Open source' : 'Open'}
                              </button>
                            </Show>
                            <Show when={!source.url}>
                              <button
                                class="btn-with-icon"
                                onClick={() => void openSource(source, true)}
                              >
                                <CopyIcon size={12} />
                                Copy location
                              </button>
                            </Show>
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </details>
                <Show when={sourceMessage()}>
                  <p role="status">{sourceMessage()}</p>
                </Show>
                <Show when={sourceError()}>
                  <p role="alert">{sourceError()}</p>
                </Show>
              </Show>
              <Show when={relations().length}>
                <h3>Interpretations</h3>
                <For each={relations()}>
                  {(relation) => (
                    <div class="investigation-relation">
                      <button
                        onClick={() =>
                          props.onSelect(
                            relation.source === props.selected ? relation.target : relation.source,
                          )
                        }
                      >
                        {titleOf(relation.source)} → {relation.kind ?? 'related'} →{' '}
                        {titleOf(relation.target)}
                      </button>
                      <p>{relation.rationale}</p>
                    </div>
                  )}
                </For>
              </Show>
            </Show>
          </>
        )}
      </Show>
      {props.children}
    </aside>
  );
}
