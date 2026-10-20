import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { InvestigationGraph } from '../InvestigationGraph';
import { InvestigationInspector } from '../InvestigationInspector';
import { noteTypes } from '../presentation';
import { KindMark } from '../../graph/KindMark';
import { LAST_STORY_SEQUENCE, makeFixture } from '../fixture';
import { acceptUpdate, snapshotAt, visibleRecords } from '../state';
import '../investigation.css';

export function InvestigationView() {
  const previousLook = document.documentElement.dataset.look;
  onCleanup(() => {
    if (previousLook === undefined) delete document.documentElement.dataset.look;
    else document.documentElement.dataset.look = previousLook;
  });
  let recordSelect: HTMLSelectElement | undefined;
  let workspace!: HTMLDivElement;
  const [workload, setWorkload] = createSignal<0 | 30 | 100>(0);
  const [history, setHistory] = createSignal(makeFixture());
  const [latest, setLatest] = createSignal(0);
  const [viewed, setViewed] = createSignal(0);
  const [selected, setSelected] = createSignal('BUG');
  const [inspectorOpen, setInspectorOpen] = createSignal(false);
  const [held, setHeld] = createSignal(false);
  const [follow, setFollow] = createSignal(true);
  const [running, setRunning] = createSignal(false);
  const [replaying, setReplaying] = createSignal(false);
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  const [locateRequest, setLocateRequest] = createSignal(0);
  const [light, setLight] = createSignal(false);
  const [reduced, setReduced] = createSignal(false);
  createEffect(() => {
    document.documentElement.dataset.look = light() ? 'islands-light' : 'islands-dark';
  });
  const snapshot = createMemo(() => snapshotAt(history(), viewed()));
  const currentWork = createMemo(() => {
    const liveSnapshot = snapshotAt(history(), latest());
    return liveSnapshot.records.find(
      (item) =>
        item.id === liveSnapshot.activeId &&
        item.status !== 'complete' &&
        item.status !== 'rejected',
    );
  });
  const visible = createMemo(() => visibleRecords(snapshot(), collapsed()));
  // Reapply after option lists change, even when the selected ID stays the same.
  createEffect(() => {
    visible();
    if (recordSelect) recordSelect.value = selected();
  });
  const changes = createMemo(() =>
    history()
      .updates.slice(0, viewed() + 1)
      .filter((u) =>
        u.operations.some((op) =>
          'id' in op
            ? op.id === selected()
            : op.type === 'insert'
              ? op.node.id === selected()
              : op.type === 'insert_relation'
                ? op.relation.source === selected() || op.relation.target === selected()
                : op.explanation.nodeId === selected(),
        ),
      ),
  );

  function hold() {
    setHeld(true);
    setFollow(false);
  }
  function select(id: string) {
    hold();
    setSelected(id);
    setInspectorOpen(true);
  }
  function receive(sequence: number) {
    setLatest(sequence);
    if (!held()) setViewed(sequence);
  }
  function live() {
    setReplaying(false);
    setHeld(false);
    setViewed(latest());
    setFollow(true);
  }
  function scrub(sequence: number) {
    hold();
    setReplaying(false);
    setViewed(sequence);
  }
  const selectedRecord = () => snapshot().records.find((item) => item.id === selected());
  function toggleBranch() {
    hold();
    setCollapsed((old) => {
      const next = new Set(old);
      if (next.has(selected())) next.delete(selected());
      else next.add(selected());
      return next;
    });
  }
  function reset(size: 0 | 30 | 100) {
    setRunning(false);
    setReplaying(false);
    setLatest(0);
    setViewed(0);
    setSelected('BUG');
    setInspectorOpen(false);
    setCollapsed(new Set<string>());
    setHeld(false);
    setFollow(true);
    setHistory(makeFixture(size));
    setWorkload(size);
  }
  function burst() {
    let next = history();
    for (let i = 0; i < 10; i++) {
      const relation = next.snapshots[LAST_STORY_SEQUENCE].relations.find((r) => r.id === 'E21-H2');
      if (!relation) return;
      next = acceptUpdate(next, {
        runId: 'duplicate-task-demo',
        sequence: next.updates.length,
        caption: `Synthetic burst ${i + 1}/10: revise E21’s annotation; no new finding.`,
        expectedRevision: next.snapshots.at(-1)?.revision ?? 0,
        actor: 'agent',
        operations: [
          {
            type: 'update_relation',
            id: relation.id,
            changes: {
              rationale: `Load-test annotation ${i + 1}. Mixed controls still prevent causal attribution.`,
            },
          },
        ],
      });
    }
    setHistory(next);
    receive(next.updates.length - 1);
  }
  onMount(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotion = () => setReduced(media.matches);
    updateMotion();
    media.addEventListener('change', updateMotion);
    const producer = setInterval(() => {
      if (running() && latest() < LAST_STORY_SEQUENCE) receive(latest() + 1);
      if (latest() >= LAST_STORY_SEQUENCE) setRunning(false);
    }, 3200);
    const playback = setInterval(() => {
      if (!replaying()) return;
      if (viewed() < latest()) setViewed(viewed() + 1);
      else setReplaying(false);
    }, 1600);
    onCleanup(() => {
      clearInterval(producer);
      clearInterval(playback);
      media.removeEventListener('change', updateMotion);
    });
  });

  return (
    <main class="investigation" data-look={light() ? 'islands-light' : 'islands-dark'}>
      <header class="investigation-heading">
        <div>
          <span class="investigation-eyebrow">INVESTIGATION · SCRIPTED PROTOTYPE</span>
          <h1>Duplicate tasks</h1>
        </div>
        <details class="investigation-demo-settings">
          <summary>Demo settings</summary>
          <div class="investigation-settings">
            <label>
              Scene{' '}
              <select
                aria-label="Scene workload"
                value={workload()}
                onChange={(e) => reset(Number(e.currentTarget.value) as 0 | 30 | 100)}
              >
                <option value="0">Story</option>
                <option value="30">30 records</option>
                <option value="100">100 records</option>
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={light()}
                onChange={(e) => setLight(e.currentTarget.checked)}
              />{' '}
              Light
            </label>
            <label>
              <input
                type="checkbox"
                checked={reduced()}
                onChange={(e) => setReduced(e.currentTarget.checked)}
              />{' '}
              Reduce motion
            </label>
          </div>
        </details>
      </header>
      <div class="investigation-toolbar">
        <button
          class="investigation-primary"
          disabled={latest() >= LAST_STORY_SEQUENCE}
          onClick={() => setRunning(!running())}
        >
          {running() ? 'Pause demo input' : 'Run demo'}
        </button>
        <button disabled={latest() >= LAST_STORY_SEQUENCE} onClick={() => receive(latest() + 1)}>
          Next demo update
        </button>
        <button disabled={latest() !== LAST_STORY_SEQUENCE} onClick={burst}>
          Burst of 10
        </button>
        <span class="investigation-divider" />
        <button
          aria-pressed={follow()}
          onClick={() => {
            if (follow()) hold();
            else live();
          }}
        >
          Follow: {follow() ? 'on' : 'off'}
        </button>
        <button aria-pressed={held()} onClick={hold}>
          Hold view
        </button>
        <button
          onClick={() => {
            hold();
            setLocateRequest((n) => n + 1);
          }}
        >
          Read selected
        </button>
        <span class="investigation-mode">{held() ? 'View held' : 'At demo live state'}</span>
      </div>
      <div
        class="investigation-current-work"
        aria-label="Current agent work"
        aria-live="polite"
        data-active={!!currentWork()}
        data-reduced={reduced()}
      >
        <span class="investigation-work-dot" aria-hidden="true" />
        <strong>Current work · demo</strong>
        <span>
          {currentWork()
            ? `${currentWork()?.id} · ${currentWork()?.title}`
            : 'No active work reported'}
        </span>
        <Show when={held()}>
          <small>Graph held at S{viewed()}; badge shows work at that snapshot.</small>
        </Show>
      </div>
      <div ref={workspace} class="investigation-workspace">
        <section class="investigation-stage" aria-label="Investigation graph">
          <div class="investigation-map-toolbar">
            <label class="investigation-browser">
              Browse notes
              <select
                aria-label="Selected record"
                ref={recordSelect}
                value={selected()}
                onChange={(e) => select(e.currentTarget.value)}
              >
                <Show when={!visible().some((r) => r.id === selected())}>
                  <option value={selected()}>{selected()} · outside this view</option>
                </Show>
                <For each={visible()}>
                  {(r) => (
                    <option value={r.id}>
                      {r.id} · {r.title}
                    </option>
                  )}
                </For>
              </select>
              <button onClick={() => select(selected())}>Inspect</button>
            </label>
            <details class="investigation-key">
              <summary>Note types</summary>
              <div>
                <For each={Object.entries(noteTypes)}>
                  {([kind, type]) => (
                    <span style={{ color: `var(${type.color})` }}>
                      <KindMark kind={kind} mark={type.mark} size={11} /> {type.label}
                    </span>
                  )}
                </For>
              </div>
            </details>
          </div>
          <Show keyed when={history().updates[0]}>
            {(_run) => (
              <InvestigationGraph
                snapshot={snapshot()}
                selected={inspectorOpen() ? selected() : ''}
                locateId={selected()}
                collapsed={collapsed()}
                follow={follow()}
                reducedMotion={reduced()}
                pulseWork={!!snapshot().activeId && snapshot().activeId === currentWork()?.id}
                locateRequest={locateRequest()}
                onSelect={select}
                onHold={hold}
              />
            )}
          </Show>
          <p class="investigation-hint">
            Hover to preview · click to inspect · scroll or drag to pan · pinch / Ctrl+scroll to
            zoom
          </p>
        </section>
        <Show when={inspectorOpen()}>
          <InvestigationInspector
            snapshot={snapshot()}
            selected={selected()}
            onSelect={select}
            onClose={(restoreFocus = true) => {
              setInspectorOpen(false);
              if (restoreFocus) recordSelect?.focus();
            }}
          >
            <Show
              when={selectedRecord()}
              fallback={<p>This record was not yet recorded at S{viewed()}.</p>}
            >
              <Show when={snapshot().records.some((item) => item.parent === selected())}>
                <button aria-expanded={!collapsed().has(selected())} onClick={toggleBranch}>
                  {collapsed().has(selected()) ? 'Reopen branch' : 'Collapse branch'}
                </button>
              </Show>
              <details class="investigation-note-history">
                <summary>Recorded changes · {changes().length}</summary>
                <ol class="investigation-history">
                  <For each={changes()}>
                    {(update) => (
                      <li>
                        <button onClick={() => scrub(update.sequence)}>S{update.sequence}</button>
                        <span>{update.caption}</span>
                      </li>
                    )}
                  </For>
                </ol>
              </details>
            </Show>
            <p class="investigation-disclosure">
              Scripted example. Observations and results are illustrative, not verified findings.
            </p>
          </InvestigationInspector>
        </Show>
      </div>
      <footer class="investigation-footer">
        <p aria-live="polite">
          <strong>{held() ? `Viewing S${viewed()}` : 'Latest change'}:</strong> {snapshot().caption}
        </p>
        <Show when={latest() > viewed()}>
          <p class="investigation-unseen">
            {latest() - viewed()} unseen updates · Latest: {snapshotAt(history(), latest()).caption}
          </p>
        </Show>
        <div class="investigation-playback">
          <button onClick={live}>Return to live</button>
          <button disabled={viewed() >= latest()} onClick={() => scrub(viewed() + 1)}>
            Step
          </button>
          <button
            aria-pressed={replaying()}
            disabled={latest() === 0}
            onClick={() => {
              hold();
              setViewed(0);
              setReplaying(true);
            }}
          >
            Replay
          </button>
          <label>
            {' '}
            S{viewed()}{' '}
            <input
              aria-label="Replay position"
              type="range"
              min="0"
              max={latest()}
              value={viewed()}
              onInput={(e) => scrub(Number(e.currentTarget.value))}
            />{' '}
            S{latest()}
          </label>
          <span>{latest() - viewed()} unseen</span>
        </div>
        <small>
          {snapshot().activeId
            ? `Declared work: ${snapshot().activeId}`
            : 'No active work declared at this snapshot.'}{' '}
          Replay controls affect presentation only. The demo input has separate controls.
        </small>
      </footer>
    </main>
  );
}
