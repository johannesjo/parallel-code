import { expectDefined } from '../store/test-helpers';

import { createSignal, untrack } from 'solid-js';

import { createStore } from 'solid-js/store';

import { applyMapOperations, mapNodeKinds } from '../../electron/shared/graph';

import { noteTypes } from './presentation';

import { emptyWorkspace } from './editing';

import { setStore } from '../store/core';

import { render } from 'solid-js/web';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeFixture } from './fixture';

import { nodeTrail } from '../graph/model';

import { ReasoningGraph } from './ReasoningGraph';

import type { Snapshot } from './state';

import type { BranchRequest } from '../graph/agentActions';

let container: HTMLDivElement;

let dispose: (() => void) | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  dispose?.();
  container.remove();
});

function mount(initial?: Snapshot, onAsk?: () => Promise<void>) {
  const [key, setKey] = createSignal('task-a');
  const [snapshot, setSnapshot] = createSignal<Snapshot | undefined>(initial);
  const [visible, setVisible] = createSignal(true);
  dispose = render(
    () => (
      <ReasoningGraph graphKey={key()} snapshot={snapshot()} visible={visible()} onAsk={onAsk} />
    ),
    container,
  );
  return { setKey, setSnapshot, setVisible };
}

function click(selector: string) {
  container
    .querySelector<HTMLButtonElement>(selector)
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function inspect(selector: string) {
  nodeMenu(selector, 'Edit details');
}

/** The card's own collapse toggle, labelled by the note title (plus any arrival count). */
function branchToggle(prefix: string) {
  return expectDefined(container.querySelector<HTMLButtonElement>(`[aria-label^="${prefix}"]`));
}

const followButton = () =>
  expectDefined(container.querySelector<HTMLButtonElement>('.reasoning-graph-actions button'));

function pause() {
  expect(followButton().textContent).toContain('Following');
  followButton().click();
  menuButton('Pause updates').click();
  expect(followButton().textContent).toContain('Paused');
}

function confirmDeletion() {
  expectDefined(document.querySelector<HTMLButtonElement>('[role="dialog"] .btn-danger')).click();
}

function nodeMenu(selector: string, label: string) {
  expectDefined(container.querySelector(selector)).dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
  );
  expectDefined(
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (item) => (item.querySelector('span')?.textContent ?? item.textContent?.trim()) === label,
    ),
  ).click();
}

function typeChoice(label: string) {
  return expectDefined(
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
      (item) => item.querySelector('span')?.textContent === label,
    ),
  );
}

function architectureSnapshot(): Snapshot {
  return {
    version: 1,
    revision: 1,
    sequence: 0,
    caption: 'Compare options',
    relations: [],
    records: [
      {
        id: 'goal',
        kind: 'goal',
        title: 'System design',
        detail: '',
        status: 'unresolved',
        criteria: ['Cost'],
      },
      {
        id: 'ingestion',
        parent: 'goal',
        kind: 'question',
        title: 'Ingestion design',
        detail: '',
        status: 'unresolved',
        criteria: ['Latency'],
      },
      {
        id: 'queue',
        parent: 'ingestion',
        kind: 'option',
        title: 'Queue workers',
        detail: 'Separate worker pool',
        status: 'proposed',
        evaluations: [{ criterion: 'Latency', assessment: 'p95 82 ms' }],
      },
      {
        id: 'direct',
        parent: 'ingestion',
        kind: 'option',
        title: 'Direct ingestion',
        detail: 'Simple deployment',
        status: 'rejected',
        criteria: ['Reversibility'],
      },
      {
        id: 'storage',
        parent: 'goal',
        kind: 'question',
        title: 'Storage design',
        detail: '',
        status: 'unresolved',
        criteria: ['Durability'],
      },
      {
        id: 'database',
        parent: 'storage',
        kind: 'option',
        title: 'Relational database',
        detail: 'Managed backups',
        status: 'proposed',
      },
    ],
  };
}

function editorInput(label: string, value: string) {
  const input = expectDefined(
    container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`),
  );
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input;
}

function menuButton(label: string) {
  return expectDefined(
    [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find(
      (button) => button.querySelector('span')?.textContent === label,
    ),
  );
}

function editorButton(label: string) {
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
  );
  if (button) return button;
  if (['HTML page', 'Markdown outline', 'Mermaid diagram', 'JSON data'].includes(label))
    editorButton('Export graph').click();
  return menuButton(label);
}

const canvasNode = (id: string) =>
  expectDefined(container.querySelector<HTMLElement>(`[data-record-id="${id}"]`));

const inlineTitle = () =>
  expectDefined(container.querySelector<HTMLTextAreaElement>('[aria-label="Idea title"]'));

function canvasKey(element: Element, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  element.dispatchEvent(event);
  return event;
}

const shownIds = () =>
  [...container.querySelectorAll('[data-record-id]')].map((node) =>
    node.getAttribute('data-record-id'),
  );

describe('editing', () => {
  it.each(mapNodeKinds)(
    'changes a reasoning node to %s and restores its data on undo',
    async (kind) => {
      const initial = architectureSnapshot();
      const original = expectDefined(initial.records.find((record) => record.id === 'queue'));
      let saved = initial;
      const onCommit = vi.fn(
        async (base: Snapshot, operations: Parameters<typeof applyMapOperations>[1]) => {
          saved = applyMapOperations(base, operations);
          return saved;
        },
      );
      dispose = render(
        () => <ReasoningGraph graphKey="types" snapshot={initial} visible onCommit={onCommit} />,
        container,
      );
      nodeMenu('[data-record-id="queue"]', 'Node type');
      expect(typeChoice('Option').getAttribute('aria-checked')).toBe('true');
      typeChoice(kind === 'idea' ? 'Plain' : noteTypes[kind].label).click();
      expect(document.querySelector('[role="menu"]')).toBeNull();
      if (kind === 'option') {
        expect(onCommit).not.toHaveBeenCalled();
        return;
      }
      await vi.waitFor(() => expect(editorButton('Undo').disabled).toBe(false));
      expect(saved.records.find((record) => record.id === 'queue')).toEqual({
        ...original,
        kind: kind === 'idea' ? undefined : kind,
        evaluations: undefined,
        userEdited: ['kind', 'evaluations'],
      });
      const shell = () => container.querySelector('[data-node-id="queue"]');
      expect(shell()?.getAttribute('data-kind')).toBe(kind);
      editorButton('Undo').click();
      await vi.waitFor(() => expect(editorButton('Redo').disabled).toBe(false));
      expect(saved.records.find((record) => record.id === 'queue')).toEqual(original);
      editorButton('Redo').click();
      await vi.waitFor(() => expect(editorButton('Undo').disabled).toBe(false));
      expect(shell()?.getAttribute('data-kind')).toBe(kind);
    },
  );

  it('clears hypothesis confidence when changing type and restores it on undo', () => {
    const initial = architectureSnapshot();
    initial.records.push({
      id: 'hypothesis',
      parent: 'goal',
      title: 'A hypothesis',
      detail: '',
      kind: 'hypothesis',
      confidence: 0.8,
    });
    mount(initial);
    nodeMenu('[data-record-id="hypothesis"]', 'Node type');
    typeChoice('Evidence').click();
    expect(container.querySelector('[data-node-id="hypothesis"]')?.getAttribute('data-kind')).toBe(
      'observation',
    );
    editorButton('Undo').click();
    inspect('[data-record-id="hypothesis"]');
    expect(container.querySelector('.investigation-inspector')?.textContent).toContain('80%');
  });

  it('retains unsent fields and questions when an asynchronous save fails', async () => {
    const onCommit = vi.fn(async () => {
      throw new Error('The graph has changed. Read it again before editing.');
    });
    const onAsk = async () => {};
    dispose = render(
      () => (
        <ReasoningGraph
          graphKey="failed-save"
          snapshot={architectureSnapshot()}
          visible
          onCommit={onCommit}
          onAsk={onAsk}
        />
      ),
      container,
    );
    inspect('[data-record-id="ingestion"]');
    editorInput('Node title', 'Keep my draft');
    editorButton('Ask agent').click();
    editorInput('Question for agent', 'Private unsent question');
    editorButton('Back to details').click();
    editorButton('Save changes').click();
    await Promise.resolve();
    await Promise.resolve();
    expect(onCommit).toHaveBeenCalledOnce();
    expect(canvasNode('ingestion').textContent).toContain('Ingestion design');
    expect(container.querySelector<HTMLInputElement>('[aria-label="Node title"]')?.value).toBe(
      'Keep my draft',
    );
    editorButton('Ask agent').click();
    expect(
      container.querySelector<HTMLTextAreaElement>('[aria-label="Question for agent"]')?.value,
    ).toBe('Private unsent question');
    expect(container.textContent).toContain('Could not save because the graph changed; try again.');
    expect(container.textContent).not.toContain('revision changed');
  });

  it('retries a revision conflict once on the refreshed graph and reports the merge', async () => {
    const [snapshot, setSnapshot] = createSignal(architectureSnapshot());
    const agentUpdate = applyMapOperations(
      architectureSnapshot(),
      [{ type: 'update', id: 'queue', changes: { detail: 'Agent evidence' } }],
      1,
      'agent',
    );
    const onCommit = vi.fn(
      async (base: Snapshot, operations: Parameters<typeof applyMapOperations>[1]) => {
        if (base.revision < agentUpdate.revision)
          throw new Error(
            "Error invoking remote method 'commit': The graph has changed. Read it again.",
          );
        return applyMapOperations(base, operations);
      },
    );
    const refresh = vi.fn(async () => {
      setSnapshot(agentUpdate);
    });
    dispose = render(
      () => (
        <ReasoningGraph
          graphKey="retry"
          snapshot={snapshot()}
          visible
          onCommit={onCommit}
          refresh={refresh}
        />
      ),
      container,
    );
    inspect('[data-record-id="ingestion"]');
    editorInput('Node title', 'Merged title');
    editorButton('Save changes').click();
    await vi.waitFor(() => expect(onCommit).toHaveBeenCalledTimes(2));
    expect(refresh).toHaveBeenCalledOnce();
    expect(onCommit.mock.calls[1]?.[0].revision).toBe(agentUpdate.revision);
    expect(canvasNode('ingestion').textContent).toContain('Merged title');
    expect(container.textContent).toContain('applied to the latest version');
    editorButton('Undo').click();
    await vi.waitFor(() =>
      expect(canvasNode('ingestion').textContent).toContain('Ingestion design'),
    );
    expect(onCommit).toHaveBeenCalledTimes(3);
  });

  it('waits for an inline save acknowledgement before adding the requested child', async () => {
    let finish: (() => void) | undefined;
    const onCommit = vi
      .fn<
        (base: Snapshot, operations: Parameters<typeof applyMapOperations>[1]) => Promise<Snapshot>
      >()
      .mockImplementationOnce(
        (base, operations) =>
          new Promise((resolve) => {
            finish = () => resolve(applyMapOperations(base, operations));
          }),
      )
      .mockImplementation(async (base, operations) => applyMapOperations(base, operations));
    dispose = render(
      () => (
        <ReasoningGraph
          graphKey="async-child"
          snapshot={architectureSnapshot()}
          visible
          onCommit={onCommit}
        />
      ),
      container,
    );
    canvasKey(canvasNode('ingestion'), 'F2');
    editorInput('Idea title', 'Saved before adding');
    canvasKey(inlineTitle(), 'Tab');
    expect(onCommit).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-record-id^="user_"]')).toBeNull();
    finish?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(canvasNode('ingestion').textContent).toContain('Saved before adding');
    await vi.waitFor(() =>
      expect(container.querySelector('[data-node-id^="user_"]')).not.toBeNull(),
    );
    expect(inlineTitle().value).toBe('New node');
  });

  it('removes deleted branch drafts only after the deletion is acknowledged', async () => {
    const [workspace, setWorkspace] = createStore(emptyWorkspace());
    let finish: (() => void) | undefined;
    const onCommit = vi.fn(
      (base: Snapshot, operations: Parameters<typeof applyMapOperations>[1]) =>
        new Promise<Snapshot>((resolve) => {
          finish = () => resolve(applyMapOperations(base, operations));
        }),
    );
    dispose = render(
      () => (
        <ReasoningGraph
          graphKey="delete-drafts"
          snapshot={architectureSnapshot()}
          visible
          workspace={workspace}
          onWorkspace={setWorkspace}
          onCommit={onCommit}
        />
      ),
      container,
    );
    inspect('[data-record-id="ingestion"]');
    editorInput('Node title', 'Unsent title');
    canvasKey(canvasNode('ingestion'), 'Delete');
    confirmDeletion();
    expect(untrack(() => workspace.drafts.ingestion?.title)).toBe('Unsent title');
    finish?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(untrack(() => workspace.drafts.ingestion)).toBeUndefined();
  });

  it('shows attached explanations inside their node, removes only the chosen block and supports undo', () => {
    const initial = makeFixture().snapshots[4];
    const explanations = [
      {
        id: 'answer-1',
        nodeId: 'H1',
        question: 'Why retries?',
        answer: 'The timeout permits another attempt.',
      },
      {
        id: 'answer-2',
        nodeId: 'H1',
        question: 'What next?',
        answer: 'Measure duplicate attempts.',
      },
    ];
    mount({ ...initial, explanations });
    const badge = () => canvasNode('H1').parentElement?.querySelector('.reasoning-node-badge');
    click('[data-record-id="H1"]');
    expect(badge()?.textContent).toBe('Q&A 2');
    expect(badge()?.getAttribute('title')).toBe('2 saved answers');
    expect(badge()?.closest('button')).toBeNull();
    inspect('[data-record-id="H1"]');
    const qa = () => expectDefined(container.querySelector('.investigation-qa'));
    expect(qa().textContent).toContain('Why retries?');
    expect(qa().textContent).toContain('The timeout permits another attempt.');
    expectDefined(
      container.querySelector<HTMLButtonElement>('[aria-label="Remove answer to “Why retries?”"]'),
    ).click();
    expect(document.activeElement?.isConnected).toBe(true);
    expect(qa().textContent).not.toContain('Why retries?');
    expect(qa().textContent).toContain('What next?');
    expect(badge()?.textContent).toBe('Q&A 1');
    click('[aria-label="Close node details"]');
    editorButton('Undo').click();
    expect(badge()?.textContent).toBe('Q&A 2');
  });

  it('shows compact source, criteria and evaluation counts on the selected card only', () => {
    mount(architectureSnapshot());
    const badges = (id: string) =>
      [...(canvasNode(id).parentElement?.querySelectorAll('.reasoning-node-badge') ?? [])].map(
        (badge) => `${badge.textContent}|${badge.getAttribute('title')}`,
      );
    click('[data-record-id="queue"]');
    expect(badges('queue')).toEqual(['⚖ 1|1 evaluation']);
    expect(badges('goal')).toEqual([]);
    expect(container.querySelectorAll('.reasoning-node-badges')).toHaveLength(1);
    click('[data-record-id="goal"]');
    expect(badges('goal')).toEqual(['✓ 1|1 acceptance criterion']);
    expect(badges('queue')).toEqual([]);
    click('[data-record-id="database"]');
    expect(badges('database')).toEqual([]);
  });

  it('keeps per-note drafts across closing and hiding, and resets them for a different graph', () => {
    const controls = mount(makeFixture().snapshots[2]);
    inspect('[data-record-id="H2"]');
    editorInput('Node title', 'My explanation');
    click('[aria-label="Close node details"]');
    inspect('[data-record-id="H1"]');
    expect(container.querySelector<HTMLInputElement>('[aria-label="Node title"]')?.value).toBe(
      'Network redelivery',
    );
    controls.setVisible(false);
    controls.setVisible(true);
    inspect('[data-record-id="H2"]');
    expect(container.querySelector<HTMLInputElement>('[aria-label="Node title"]')?.value).toBe(
      'My explanation',
    );
    controls.setKey('new-run');
    inspect('[data-record-id="H2"]');
    expect(container.querySelector<HTMLInputElement>('[aria-label="Node title"]')?.value).toBe(
      'Retry reapplication',
    );
  });

  it('adds an editable child note, opens its branch, and can undo creation', () => {
    mount(makeFixture().snapshots[5]);
    click('[data-record-id="H2"]');
    branchToggle('Collapse Retry reapplication').click();
    nodeMenu('[data-record-id="H2"]', 'Add child node');
    inspect('[data-node-id][data-selected="true"]');
    const newNode = expectDefined(container.querySelector('[data-record-id^="user_"]'));
    expect(newNode.textContent).toContain('New node');
    expect(container.textContent).toContain('Your node');
    editorInput('Node title', 'What about retries?');
    editorButton('Save changes').click();
    expect(newNode.textContent).toContain('What about retries?');
    editorButton('Undo').click();
    expect(newNode.textContent).toContain('New node');
    editorButton('Undo').click();
    expect(container.querySelector('[data-record-id^="user_"]')).toBeNull();
  });

  it('stays docked through outside input and follows the selection, keeping each draft', () => {
    mount(makeFixture().snapshots[2]);
    inspect('[data-record-id="H2"]');
    editorInput('Node title', 'Draft while navigating');
    const follow = followButton();
    follow.focus();
    follow.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(container.querySelector('.investigation-inspector')).not.toBeNull();
    expect(document.activeElement).toBe(follow);
    const title = () =>
      container.querySelector<HTMLInputElement>('[aria-label="Node title"]')?.value;
    click('[data-record-id="BUG"]');
    expect(container.querySelector('.investigation-inspector')).not.toBeNull();
    expect(title()).not.toBe('Draft while navigating');
    click('[data-record-id="H2"]');
    expect(title()).toBe('Draft while navigating');
  });

  it('keeps a question across undo while refreshing clean saved text to match the graph', () => {
    mount(makeFixture().snapshots[2], async () => {});
    inspect('[data-record-id="H2"]');
    editorInput('Node title', 'Saved local title');
    editorButton('Ask agent').click();
    editorInput('Question for agent', 'What evidence supports this?');
    editorButton('Back to details').click();
    editorButton('Save changes').click();
    editorButton('Undo').click();
    inspect('[data-record-id="H2"]');
    expect(container.querySelector<HTMLInputElement>('[aria-label="Node title"]')?.value).toBe(
      'Retry reapplication',
    );
    editorButton('Ask agent').click();
    expect(
      container.querySelector<HTMLTextAreaElement>('[aria-label="Question for agent"]')?.value,
    ).toBe('What evidence supports this?');
    editorButton('Redo').click();
    inspect('[data-record-id="H2"]');
    expect(container.querySelector<HTMLInputElement>('[aria-label="Node title"]')?.value).toBe(
      'Saved local title',
    );
  });

  it('retains hidden note cards while the user interacts with another pane', () => {
    const controls = mount(makeFixture().snapshots[2]);
    inspect('[data-record-id="H2"]');
    editorInput('Node title', 'Keep this draft');
    controls.setVisible(false);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    controls.setVisible(true);
    expect(container.querySelector<HTMLInputElement>('[aria-label="Node title"]')?.value).toBe(
      'Keep this draft',
    );
  });

  it.each([true])('preserves an unsent question when resetting note text (dirty=%s)', (dirty) => {
    mount(makeFixture().snapshots[2], async () => {});
    inspect('[data-record-id="H2"]');
    editorInput('Node title', 'Saved local title');
    editorButton('Save changes').click();
    editorButton('Ask agent').click();
    editorInput('Question for agent', 'Please verify the retry behavior');
    editorButton('Back to details').click();
    if (dirty) editorInput('Node title', 'Unfinished title');
    editorButton('Use agent version').click();
    const expectedTitle = dirty ? 'Saved local title' : 'Retry reapplication';
    expect(container.querySelector<HTMLInputElement>('[aria-label="Node title"]')?.value).toBe(
      expectedTitle,
    );
    expect(container.querySelector('[data-record-id="H2"]')?.textContent).toContain(expectedTitle);
    click('[aria-label="Close node details"]');
    inspect('[data-record-id="H2"]');
    editorButton('Ask agent').click();
    expect(
      container.querySelector<HTMLTextAreaElement>('[aria-label="Question for agent"]')?.value,
    ).toBe('Please verify the retry behavior');
    editorButton('Undo').click();
    inspect('[data-record-id="H2"]');
    editorButton('Ask agent').click();
    expect(
      container.querySelector<HTMLTextAreaElement>('[aria-label="Question for agent"]')?.value,
    ).toBe('Please verify the retry behavior');
  });

  it('offers note creation from the context menu and focuses the new title without losing the parent draft', async () => {
    mount(makeFixture().snapshots[2]);
    inspect('[data-record-id="H2"]');
    editorInput('Node title', 'Parent draft');
    click('[aria-label="Close node details"]');
    nodeMenu('[data-node-id="H2"]', 'Add child node');
    await Promise.resolve();
    const title = expectDefined(
      container.querySelector<HTMLTextAreaElement>('[aria-label="Idea title"]'),
    );
    expect(title.value).toBe('New node');
    expect(document.activeElement).toBe(title);
    expect(title.selectionEnd).toBe(title.value.length);
    inspect('[data-record-id="H2"]');
    expect(container.querySelector<HTMLInputElement>('[aria-label="Node title"]')?.value).toBe(
      'Parent draft',
    );
  });

  it.each(['Delete', 'Backspace', 'context menu'])(
    'deletes a reasoning branch via %s and supports undo',
    async (action) => {
      mount(architectureSnapshot());
      if (action === 'context menu') {
        canvasNode('ingestion').dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        );
        expectDefined(
          [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
            (item) => item.querySelector('span')?.textContent === 'Delete node',
          ),
        ).click();
      } else canvasKey(canvasNode('ingestion'), action);
      await Promise.resolve();
      expect(canvasNode('ingestion')).toBeDefined();
      const dialog = expectDefined(document.querySelector('[role="dialog"]'));
      expect(dialog.textContent).toContain('“Ingestion design” and 2 connected nodes');
      confirmDeletion();
      await Promise.resolve();
      expect(container.querySelector('[data-record-id="ingestion"]')).toBeNull();
      expect(container.querySelector('[data-record-id="queue"]')).toBeNull();
      expect(canvasNode('storage')).toBeDefined();
      editorButton('Undo').click();
      expect(canvasNode('ingestion')).toBeDefined();
      expect(canvasNode('queue')).toBeDefined();
      editorButton('Redo').click();
      expect(container.querySelector('[data-record-id="ingestion"]')).toBeNull();
    },
  );

  it('protects the reasoning root and leaves Delete inside inline text editing alone', async () => {
    mount(architectureSnapshot());
    canvasKey(canvasNode('goal'), 'Delete');
    expect(canvasNode('goal')).toBeDefined();
    canvasKey(canvasNode('ingestion'), 'F2');
    await Promise.resolve();
    expect(canvasKey(inlineTitle(), 'Delete').defaultPrevented).toBe(false);
    canvasKey(inlineTitle(), 'Enter');
    expect(canvasNode('ingestion')).toBeDefined();
  });

  it('offers inline rename and reasoning details for the right-clicked note', async () => {
    mount(makeFixture().snapshots[2]);
    const open = () =>
      canvasNode('H2').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
    const action = (label: string) =>
      expectDefined(
        [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
          (item) => item.querySelector('span')?.textContent === label,
        ),
      );
    open();
    action('Rename').click();
    await Promise.resolve();
    expect(document.activeElement).toBe(inlineTitle());
    editorInput('Idea title', 'Revised hypothesis');
    canvasKey(inlineTitle(), 'Enter');
    expect(canvasNode('H2').textContent).toContain('Revised hypothesis');
    open();
    action('Edit details').click();
    expect(container.querySelector('.investigation-inspector')).not.toBeNull();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    open();
    action('Add child node').click();
    await Promise.resolve();
    expect(inlineTitle().value).toBe('New node');
    expect(document.activeElement).toBe(inlineTitle());
  });

  it('keeps an inline draft on conflict and resolves it explicitly through Details', () => {
    const initial = makeFixture().snapshots[2];
    const controls = mount(initial);
    canvasKey(canvasNode('H2'), 'F2');
    editorInput('Idea title', 'Local explanation');
    controls.setSnapshot({
      ...initial,
      version: 1,
      revision: 4,
      sequence: 3,
      records: initial.records.map((record) =>
        record.id === 'H2'
          ? {
              ...record,
              title: 'Agent explanation',
              detail: 'New evidence',
              confidence: 0.8,
              status: 'supported' as const,
            }
          : record,
      ),
    });
    canvasKey(inlineTitle(), 'Tab');
    expect(inlineTitle().value).toBe('Local explanation');
    expect(container.querySelector('[data-record-id^="user_"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'graph updated this node',
    );
    inspect('[data-node-id][data-selected="true"]');
    expect(container.querySelector<HTMLInputElement>('[aria-label="Node title"]')?.value).toBe(
      'Local explanation',
    );
    editorButton('Keep my changes').click();
    expect(canvasNode('H2').textContent).toContain('Local explanation');
    expect(canvasNode('H2').getAttribute('aria-label')).toContain('supported');
    expect(canvasNode('H2').getAttribute('aria-label')).toContain('80%');
    editorButton('Undo').click();
    expect(canvasNode('H2').textContent).toContain('Agent explanation');
    expect(initial.records.find((record) => record.id === 'H2')?.title).toBe('Retry reapplication');
  });

  it('drops an inline rename whose node the agent removed', () => {
    const initial = makeFixture().snapshots[2];
    const controls = mount(initial);
    canvasKey(canvasNode('H2'), 'F2');
    editorInput('Idea title', 'Local explanation');
    controls.setSnapshot({
      ...initial,
      version: 1,
      revision: 4,
      sequence: 3,
      records: initial.records.filter((record) => record.id !== 'H2'),
      relations: (initial.relations ?? []).filter(
        (link) => link.source !== 'H2' && link.target !== 'H2',
      ),
    });
    // The draft can never save now, and inlineEditing short-circuits every other action
    // on a failed save — rename, add, delete and Export would all stay dead.
    expect(container.querySelector('[aria-label="Idea title"]')).toBeNull();
    canvasKey(canvasNode('H1'), 'F2');
    expect(inlineTitle().value).toBe('Network redelivery');
  });

  it('keeps description and question drafts independent from inline rename and cancellation', () => {
    mount(makeFixture().snapshots[2], async () => {});
    inspect('[data-record-id="H2"]');
    editorInput('Node notes', 'Unfinished evidence');
    editorButton('Ask agent').click();
    editorInput('Question for agent', 'Please verify');
    editorButton('Back to details').click();
    click('[aria-label="Close node details"]');
    canvasKey(canvasNode('H2'), 'F2');
    editorInput('Idea title', 'Saved title');
    inlineTitle().dispatchEvent(new FocusEvent('blur'));
    expect(canvasNode('H2').textContent).toContain('Saved title');
    canvasKey(canvasNode('H2'), 'F2');
    editorInput('Idea title', 'Cancel this');
    canvasKey(inlineTitle(), 'Escape');
    inspect('[data-node-id][data-selected="true"]');
    expect(container.querySelector<HTMLInputElement>('[aria-label="Node title"]')?.value).toBe(
      'Saved title',
    );
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Node notes"]')?.value).toBe(
      'Unfinished evidence',
    );
    expect(editorButton('Save changes')).toBeDefined();
    editorButton('Ask agent').click();
    expect(
      container.querySelector<HTMLTextAreaElement>('[aria-label="Question for agent"]')?.value,
    ).toBe('Please verify');
  });

  it('retains inline drafts while hidden, isolates graph runs, and honors IME and text undo', () => {
    const controls = mount(makeFixture().snapshots[2]);
    canvasKey(canvasNode('H2'), 'F2');
    editorInput('Idea title', 'Unfinished');
    controls.setVisible(false);
    inlineTitle().dispatchEvent(new FocusEvent('blur'));
    controls.setVisible(true);
    expect(inlineTitle().value).toBe('Unfinished');
    canvasKey(inlineTitle(), 'Enter', { isComposing: true });
    expect(container.querySelector('[data-record-id^="user_"]')).toBeNull();
    expect(canvasKey(inlineTitle(), 'z', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(canvasKey(inlineTitle(), 'Tab', { shiftKey: true }).defaultPrevented).toBe(false);
    controls.setKey('another-run');
    expect(container.querySelector('[aria-label="Idea title"]')).toBeNull();
    canvasKey(canvasNode('H2'), 'F2');
    expect(inlineTitle().value).toBe('Retry reapplication');
  });

  it('prepares branch requests from the saved user view, including added notes and excluding deletions', () => {
    const onBranchRequest = vi.fn<(request: BranchRequest) => void>();
    const snapshot = applyMapOperations(architectureSnapshot(), [
      { type: 'update', id: 'ingestion', changes: { title: 'My ingestion design' } },
      {
        type: 'insert',
        node: {
          id: 'user_note',
          parent: 'ingestion',
          kind: 'question',
          status: 'unresolved',
          title: 'My question',
          detail: 'Saved context',
        },
      },
      { type: 'remove', id: 'queue' },
    ]);
    dispose = render(
      () => (
        <ReasoningGraph
          graphKey="branch-request"
          snapshot={snapshot}
          visible
          onBranchRequest={onBranchRequest}
          workspace={{
            ...emptyWorkspace(),
            drafts: {
              ingestion: {
                title: 'Unsent draft',
                detail: '',
                base: { title: 'My ingestion design', detail: '' },
                question: 'Private question',
              },
            },
          }}
        />
      ),
      container,
    );
    expectDefined(container.querySelector('[data-record-id="ingestion"]')).dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 120,
        clientY: 120,
      }),
    );
    const choose = (label: string) =>
      expectDefined(
        [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
          (button) => button.querySelector('span')?.textContent === label,
        ),
      ).click();
    choose('Send branch to agent');
    choose('Investigate this branch');
    const request = expectDefined(onBranchRequest.mock.calls[0]?.[0]);
    expect(request).toMatchObject({
      intent: 'investigate',
      rootId: 'ingestion',
      revision: snapshot.revision,
    });
    expect(request.map.records.find((node) => node.id === 'ingestion')?.title).toBe(
      'My ingestion design',
    );
    expect(request.map.records.some((node) => node.id === 'user_note')).toBe(true);
    expect(request.map.records.some((node) => node.id === 'queue')).toBe(false);
    expect(JSON.stringify(request)).not.toContain('Unsent draft');
  });

  it('closes Details and keeps the draft when the selected note leaves the graph', () => {
    const initial = architectureSnapshot();
    const controls = mount(initial);
    inspect('[data-record-id="queue"]');
    editorInput('Node notes', 'Unsent thoughts');
    controls.setSnapshot(
      applyMapOperations(
        initial,
        [{ type: 'remove', id: 'queue', overrideUser: true }],
        1,
        'agent',
      ),
    );
    expect(container.querySelector('.investigation-inspector')).toBeNull();
    expect(container.querySelector('[data-node-id][data-selected="true"]')).toBeNull();
    expect(canvasNode('goal').tabIndex).toBe(0);
    controls.setSnapshot(initial);
    inspect('[data-record-id="queue"]');
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Node notes"]')?.value).toBe(
      'Unsent thoughts',
    );
  });

  it('offers Release to agent for protected notes only while ownership badges are enabled', () => {
    const protectedSnapshot = applyMapOperations(architectureSnapshot(), [
      { type: 'update', id: 'ingestion', changes: { title: 'My ingestion design' } },
    ]);
    const menuLabels = () =>
      [...document.querySelectorAll('[role="menuitem"] span')].map((item) => item.textContent);
    mount(protectedSnapshot);
    canvasNode('queue').dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    expect(menuLabels()).not.toContain('Release to agent');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    nodeMenu('[data-record-id="ingestion"]', 'Release to agent');
    expect(container.textContent).toContain('Changes saved');
    inspect('[data-record-id="ingestion"]');
    expect(container.textContent).toContain('Edit the title or description, then save.');
    expect(container.textContent).not.toContain('Your saved version');
    editorButton('Undo').click();
    inspect('[data-record-id="ingestion"]');
    expect(container.textContent).toContain('Your saved version');
    setStore('canvasOwnershipBadges', false);
    try {
      canvasNode('ingestion').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
      expect(menuLabels()).not.toContain('Release to agent');
    } finally {
      setStore('canvasOwnershipBadges', true);
    }
  });

  it('reports a queued question and shows Saving separately from Sending', async () => {
    let finishSave: (() => void) | undefined;
    const onCommit = vi.fn(
      (base: Snapshot, operations: Parameters<typeof applyMapOperations>[1]) =>
        new Promise<Snapshot>((resolve) => {
          finishSave = () => resolve(applyMapOperations(base, operations));
        }),
    );
    const onAsk = vi.fn(async () => 'queued' as const);
    dispose = render(
      () => (
        <ReasoningGraph
          graphKey="queued"
          snapshot={architectureSnapshot()}
          visible
          onCommit={onCommit}
          onAsk={onAsk}
        />
      ),
      container,
    );
    inspect('[data-record-id="ingestion"]');
    editorInput('Node title', 'Saved later');
    editorButton('Save changes').click();
    expect(editorButton('Saving…').disabled).toBe(true);
    editorButton('Ask agent').click();
    editorInput('Question for agent', 'Is this right?');
    expect(editorButton('Send question').disabled).toBe(false);
    editorButton('Send question').click();
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Queued until the agent is ready.'),
    );
    expect(onAsk).toHaveBeenCalledOnce();
    finishSave?.();
    await vi.waitFor(() => expect(canvasNode('ingestion').textContent).toContain('Saved later'));
  });

  it('deletes leaves immediately and keeps a branch when the confirmation is cancelled', async () => {
    mount(architectureSnapshot());
    canvasKey(canvasNode('database'), 'Delete');
    expect(document.querySelector('[role="dialog"] .btn-danger')).toBeNull();
    expect(container.querySelector('[data-record-id="database"]')).toBeNull();
    canvasKey(canvasNode('ingestion'), 'Backspace');
    expectDefined(
      document.querySelector<HTMLButtonElement>('[role="dialog"] .btn-secondary'),
    ).click();
    await Promise.resolve();
    expect(canvasNode('ingestion')).toBeDefined();
    expect(canvasNode('queue')).toBeDefined();
    expect(document.querySelector('[role="dialog"] .btn-danger')).toBeNull();
  });
});

describe('undo and redo', () => {
  it('keeps undo across later agent updates and reverts only the user edit', () => {
    const original = architectureSnapshot();
    const controls = mount(original);
    inspect('[data-record-id="ingestion"]');
    editorInput('Node title', 'My saved title');
    editorButton('Save changes').click();
    expect(editorButton('Undo').disabled).toBe(false);
    const saved = applyMapOperations(original, [
      { type: 'update', id: 'ingestion', changes: { title: 'My saved title' } },
    ]);
    const external = applyMapOperations(
      saved,
      [
        { type: 'update', id: 'queue', changes: { detail: 'New agent evidence' } },
        {
          type: 'insert',
          node: { id: 'agent_new', parent: 'ingestion', title: 'Agent idea', detail: '' },
        },
      ],
      saved.revision,
      'agent',
    );
    controls.setSnapshot(external);
    expect(editorButton('Undo').disabled).toBe(false);
    expect(container.textContent).not.toContain('undo history was cleared');
    editorButton('Undo').click();
    expect(canvasNode('ingestion').textContent).toContain('Ingestion design');
    expect(canvasNode('agent_new')).toBeDefined();
    inspect('[data-record-id="queue"]');
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Node notes"]')?.value).toBe(
      'New agent evidence',
    );
    editorButton('Redo').click();
    expect(canvasNode('ingestion').textContent).toContain('My saved title');
  });

  it('gives up undo only when the agent removed the edited note', () => {
    const original = architectureSnapshot();
    const controls = mount(original);
    inspect('[data-record-id="ingestion"]');
    editorInput('Node title', 'My saved title');
    editorButton('Save changes').click();
    const saved = applyMapOperations(original, [
      { type: 'update', id: 'ingestion', changes: { title: 'My saved title' } },
    ]);
    controls.setSnapshot(
      applyMapOperations(
        saved,
        [{ type: 'remove', id: 'ingestion', overrideUser: true }],
        saved.revision,
        'agent',
      ),
    );
    click('[aria-label="Close node details"]');
    editorButton('Undo').click();
    expect(container.textContent).toContain('Undo is no longer available');
    expect(editorButton('Undo').disabled).toBe(true);
  });

  it('keeps the undo step for a retry when a non-conflict save error interrupts it', async () => {
    let failing = false;
    const onCommit = vi.fn(
      async (base: Snapshot, operations: Parameters<typeof applyMapOperations>[1]) => {
        if (failing) throw new Error('The graph log is temporarily unreadable.');
        return applyMapOperations(base, operations);
      },
    );
    dispose = render(
      () => (
        <ReasoningGraph
          graphKey="undo-error"
          snapshot={architectureSnapshot()}
          visible
          onCommit={onCommit}
        />
      ),
      container,
    );
    inspect('[data-record-id="ingestion"]');
    editorInput('Node title', 'My saved title');
    editorButton('Save changes').click();
    await vi.waitFor(() => expect(canvasNode('ingestion').textContent).toContain('My saved title'));
    failing = true;
    editorButton('Undo').click();
    await vi.waitFor(() =>
      expect(container.textContent).toContain('The graph log is temporarily unreadable.'),
    );
    expect(container.textContent).not.toContain('Undo is no longer available');
    expect(canvasNode('ingestion').textContent).toContain('My saved title');
    expect(editorButton('Undo').disabled).toBe(false);
    expect(editorButton('Redo').disabled).toBe(true);
    failing = false;
    editorButton('Undo').click();
    await vi.waitFor(() =>
      expect(canvasNode('ingestion').textContent).toContain('Ingestion design'),
    );
    expect(onCommit).toHaveBeenCalledTimes(3);
    expect(onCommit.mock.calls[2]?.[1]).toEqual(onCommit.mock.calls[1]?.[1]);
    expect(editorButton('Redo').disabled).toBe(false);
  });

  it('saves only changed fields against the latest report and supports undo and redo', () => {
    const initial = makeFixture().snapshots[2];
    const controls = mount(initial);
    inspect('[data-record-id="H2"]');
    editorInput('Node title', 'My explanation');
    controls.setSnapshot({
      ...initial,
      version: 1,
      revision: 4,
      sequence: 3,
      records: initial.records.map((r) =>
        r.id === 'H2'
          ? {
              ...r,
              title: 'Agent explanation',
              detail: 'Fresh evidence',
              status: 'supported' as const,
            }
          : r,
      ),
    });
    expect(container.querySelector<HTMLInputElement>('[aria-label="Node title"]')?.value).toBe(
      'My explanation',
    );
    expect(container.textContent).toContain('The agent updated this note’s title');
    editorButton('Keep my changes').click();
    expect(container.querySelector('[data-record-id="H2"]')?.textContent).toContain(
      'My explanation',
    );
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Node notes"]')?.value).toBe(
      'Fresh evidence',
    );
    expect(container.querySelector('.investigation-note-type')?.textContent).toContain('supported');
    editorButton('Undo').click();
    expect(container.querySelector('[data-record-id="H2"]')?.textContent).toContain(
      'Agent explanation',
    );
    editorButton('Redo').click();
    expect(container.querySelector('[data-record-id="H2"]')?.textContent).toContain(
      'My explanation',
    );
    expect(initial.records.find((r) => r.id === 'H2')?.title).toBe('Retry reapplication');
  });

  it('keeps undo snapshots independent of Solid stores and restores a keyboard target after undoing creation', async () => {
    const [workspace, setWorkspace] = createStore(emptyWorkspace());
    dispose = render(
      () => (
        <ReasoningGraph
          graphKey="store"
          snapshot={makeFixture().snapshots[2]}
          visible
          workspace={workspace}
          onWorkspace={(next) => setWorkspace(next)}
        />
      ),
      container,
    );
    canvasKey(canvasNode('H2'), 'Tab');
    editorInput('Idea title', 'First title');
    inlineTitle().dispatchEvent(new FocusEvent('blur'));
    const id = expectDefined(
      container.querySelector('[data-record-id^="user_"]')?.getAttribute('data-record-id'),
    );
    canvasKey(canvasNode(id), 'F2');
    editorInput('Idea title', 'Second title');
    inlineTitle().dispatchEvent(new FocusEvent('blur'));
    editorButton('Undo').click();
    expect(canvasNode(id).textContent).toContain('First title');
    editorButton('Undo').click();
    expect(canvasNode(id).textContent).toContain('New node');
    editorButton('Undo').click();
    await Promise.resolve();
    expect(container.querySelector('[data-record-id^="user_"]')).toBeNull();
    expect(container.querySelector('[data-record-id][tabindex="0"]')).toBe(document.activeElement);
    editorButton('Redo').click();
    editorButton('Redo').click();
    editorButton('Redo').click();
    expect(canvasNode(id).textContent).toContain('Second title');
  });
});

describe('following and pausing updates', () => {
  it('shows the new graph when switching keys at the same committed revision', () => {
    const original = architectureSnapshot();
    const controls = mount(original);
    inspect('[data-record-id="ingestion"]');
    editorInput('Node title', 'Old run user title');
    editorButton('Save changes').click();
    controls.setSnapshot({
      ...original,
      revision: original.revision + 1,
      records: [{ ...original.records[0], title: 'Different run root' }],
    });
    controls.setKey('different-run');
    expect(container.textContent).toContain('Different run root');
    expect(container.textContent).not.toContain('Old run user title');
    expect(container.querySelector('[data-record-id="ingestion"]')).toBeNull();
  });

  it('preserves the graph and held comparison until returning to current', () => {
    const initial = architectureSnapshot();
    const controls = mount(initial);
    const graph = container.querySelector('.investigation-svg');
    const viewButton = editorButton;
    viewButton('Compare options').click();
    click('[data-option-id="queue"]');
    expect(container.querySelector('.investigation-inspector')?.textContent).toContain('p95 82 ms');
    pause();
    controls.setSnapshot({
      ...initial,
      version: 1,
      revision: 2,
      sequence: 1,
      records: initial.records.map((r) =>
        r.id === 'queue'
          ? { ...r, evaluations: [{ criterion: 'Latency', assessment: 'p95 95 ms' }] }
          : r,
      ),
    });
    expect(container.querySelector('table')?.textContent).toContain('p95 82 ms');
    expect(container.querySelector('table')?.textContent).not.toContain('p95 95 ms');
    expect(followButton().textContent).toContain('Paused · new updates');
    click('.reasoning-graph-update');
    menuButton('Follow updates').click();
    expect(followButton().textContent).toContain('Following');
    expect(container.querySelector('table')?.textContent).toContain('p95 95 ms');
    viewButton('Show graph').click();
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('.investigation-svg')).toBe(graph);
    viewButton('Compare options').click();
    controls.setKey('new-run');
    expect(container.querySelector('table')).toBeNull();
  });

  it('shows a neutral empty state and resets when graph identity changes', () => {
    const fixture = makeFixture();
    const controls = mount();
    expect(container.textContent).toContain('No reasoning graph available for this task');
    controls.setSnapshot(fixture.snapshots[1]);
    expect(container.textContent).toContain('Network redelivery');
    inspect('[data-record-id="BUG"]');
    expect(container.textContent).toContain('NODE DETAILS');
    controls.setKey('task-b');
    controls.setSnapshot(undefined);
    expect(container.textContent).not.toContain('NODE DETAILS');
    expect(container.textContent).toContain('No reasoning graph available for this task');
  });

  it('holds selected snapshots and only adopts newer input on request', () => {
    const fixture = makeFixture();
    const controls = mount(fixture.snapshots[1]);
    inspect('[data-record-id="BUG"]');
    pause();
    controls.setSnapshot(fixture.snapshots[2]);
    expect(container.textContent).toContain('Paused · new updates');
    expect(container.textContent).not.toContain('Candidate client causes');
    click('.reasoning-graph-update');
    menuButton('Follow updates').click();
    expect(container.textContent).toContain('Retry reapplication');
    expect(container.textContent).not.toContain('newer available');
    expect(container.querySelector('.investigation-inspector')).not.toBeNull();
  });

  it('keeps working animation enabled during selection and marks held and idle work as past', () => {
    const fixture = makeFixture();
    const controls = mount(fixture.snapshots[7]);
    const badge = () => expectDefined(container.querySelector('.investigation-working-label'));
    expect(badge().textContent).toContain('Working now');
    expect(badge().getAttribute('data-working')).toBe('true');
    inspect('[data-record-id="H1"]');
    expect(badge().getAttribute('data-working')).toBe('true');
    pause();
    controls.setSnapshot(fixture.snapshots[8]);
    expect(badge().textContent).toContain('Worked on last');
    expect(badge().getAttribute('data-working')).toBe('false');
    click('.reasoning-graph-update');
    menuButton('Follow updates').click();
    expect(badge().textContent).toContain('Worked on last');
    expect(badge().closest('.investigation-node-shell')?.getAttribute('data-node-id')).toBe('T5');
    expect(badge().getAttribute('data-working')).toBe('false');
    controls.setKey('another-run');
    controls.setSnapshot({ ...fixture.snapshots[0], activeId: undefined, lastActiveId: undefined });
    expect(container.querySelector('.investigation-working-label')).toBeNull();
  });

  it('skips hidden revisions while following and preserves a held hidden view', () => {
    const fixture = makeFixture();
    const controls = mount(fixture.snapshots[1]);
    controls.setVisible(false);
    controls.setSnapshot(fixture.snapshots[2]);
    expect(container.textContent).not.toContain('Retry reapplication');
    controls.setVisible(true);
    expect(container.textContent).toContain('Retry reapplication');
    inspect('[data-record-id="H1"]');
    pause();
    controls.setVisible(false);
    controls.setSnapshot(fixture.snapshots[3]);
    controls.setVisible(true);
    expect(container.textContent).toContain('Paused · new updates');
    expect(container.textContent).not.toContain('Storage duplication');
  });

  it('ignores redelivery of the same revision', () => {
    const fixture = makeFixture();
    const controls = mount(fixture.snapshots[2]);
    controls.setSnapshot({
      ...fixture.snapshots[2],
      records: fixture.snapshots[2].records.map((record) =>
        record.id === 'H2' ? { ...record, title: 'Changed duplicate' } : record,
      ),
    });
    expect(container.textContent).toContain('Retry reapplication');
    expect(container.textContent).not.toContain('Changed duplicate');
  });

  it('clears a held graph when its snapshot is removed', () => {
    const controls = mount(makeFixture().snapshots[2]);
    inspect('[data-record-id="H2"]');
    controls.setSnapshot(undefined);
    expect(container.textContent).toContain('No reasoning graph available for this task');
    expect(container.textContent).not.toContain('NODE DETAILS');
  });

  it('resets the camera when the graph key changes with a snapshot present', () => {
    const controls = mount(makeFixture().snapshots[2]);
    const svg = expectDefined(container.querySelector('.investigation-svg'));
    click('[aria-label="Zoom in"]');
    controls.setVisible(false);
    controls.setKey('task-b');
    expect(container.querySelector('.investigation-svg')).not.toBe(svg);
  });

  it('shows hidden arrivals immediately when following resumes', () => {
    vi.useFakeTimers();
    try {
      const fixture = makeFixture();
      const controls = mount(fixture.snapshots[4]);
      vi.advanceTimersByTime(400);
      controls.setVisible(false);
      controls.setSnapshot(fixture.snapshots[5]);
      controls.setVisible(true);
      const arrival = container.querySelector('[data-record-id="H21"]')?.closest('foreignObject');
      expect((arrival as SVGForeignObjectElement).style.opacity).toBe('1');
    } finally {
      dispose?.();
      dispose = undefined;
      vi.useRealTimers();
    }
  });

  it('Find current expands a collapsed ancestor without adopting newer held input', () => {
    const fixture = makeFixture();
    const controls = mount(fixture.snapshots[5]);
    inspect('[data-record-id="H2"]');
    pause();
    const button = (text: string) =>
      expectDefined([...container.querySelectorAll('button')].find((b) => b.textContent === text));
    branchToggle('Collapse Retry reapplication').click();
    expect(container.querySelector('[data-record-id="H21"]')).toBeNull();
    controls.setSnapshot(fixture.snapshots[6]);
    button('Find current').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(container.querySelector('[data-record-id="H21"]')).not.toBeNull();
    expect(container.textContent).toContain('Paused · new updates');
  });

  it('disables Find current when the snapshot reports no active work', () => {
    mount({ ...makeFixture().snapshots[2], activeId: undefined });
    expect(
      container.querySelector<HTMLButtonElement>('[title="No current work reported"]')?.disabled,
    ).toBe(true);
  });

  it('keeps following through selection, collapsing and canvas holds; only the toggle pauses', () => {
    const fixture = makeFixture();
    const controls = mount(fixture.snapshots[5]);
    click('[data-record-id="H2"]');
    inspect('[data-record-id="H2"]');
    branchToggle('Collapse Retry reapplication').click();
    container
      .querySelector('.investigation-svg')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(followButton().textContent).toContain('Following');
    expect(followButton().hasAttribute('aria-pressed')).toBe(false);
    controls.setSnapshot(fixture.snapshots[6]);
    expect(followButton().textContent).toContain('Following');
    inspect('[data-record-id="H2"]');
    branchToggle('Expand Retry reapplication').click();
    const added = expectDefined(
      fixture.snapshots[6].records.find(
        (record) => !fixture.snapshots[5].records.some((old) => old.id === record.id),
      ),
    );
    expect(container.textContent).toContain(added.title);
    expect(container.querySelector('.investigation-mode')).toBeNull();
    pause();
    controls.setSnapshot(fixture.snapshots[7]);
    expect(followButton().textContent).toContain('Paused · new updates');
    expect(followButton().classList.contains('reasoning-graph-update')).toBe(true);
    followButton().click();
    menuButton('Follow updates').click();
    expect(followButton().textContent).toContain('Following');
  });
});

describe('option comparison', () => {
  it('compares sibling options against inherited criteria without inventing assessments', () => {
    mount(architectureSnapshot());
    editorButton('Compare options').click();
    const tables = container.querySelectorAll('table');
    expect(tables).toHaveLength(2);
    expect(tables[0].querySelector('caption')?.textContent).toBe('Ingestion design');
    expect([...tables[0].querySelectorAll('tbody th')].map((th) => th.textContent)).toEqual([
      'Overview',
      'Cost',
      'Latency',
      'Reversibility',
    ]);
    expect(tables[0].textContent).toContain('p95 82 ms');
    expect(tables[0].textContent).toContain('Not assessed');
    expect(tables[0].textContent).toContain('rejected');
    expect(tables[0].textContent).not.toContain('Relational database');
    expect(tables[1].textContent).toContain('Durability');
    expect(tables[1].textContent).not.toContain('Latency');
  });

  it('preserves comparison buttons and keyboard focus across live revisions', () => {
    const initial = architectureSnapshot();
    const controls = mount(initial);
    editorButton('Compare options').click();
    const button = expectDefined(
      container.querySelector<HTMLButtonElement>('[data-option-id="queue"]'),
    );
    button.focus();
    controls.setSnapshot({
      ...initial,
      version: 1,
      revision: 2,
      sequence: 1,
      records: initial.records.map((record) =>
        record.id === 'queue' ? { ...record, title: 'Updated queue workers' } : record,
      ),
    });
    expect(container.querySelector('[data-option-id="queue"]')).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(button.textContent).toBe('Updated queue workers');
  });

  it('enables comparison when the first option is created locally', () => {
    mount(makeFixture().snapshots[2]);
    nodeMenu('[data-record-id="BUG"]', 'Add child node');
    inlineTitle().dispatchEvent(new FocusEvent('blur'));
    nodeMenu('[data-node-id][data-selected="true"]', 'Node type');
    typeChoice('Option').click();
    editorButton('Compare options').click();
    expect(container.querySelector('table')?.textContent).toContain('New node');
  });

  it('always offers a way out of the comparison and closes it when options disappear', () => {
    const initial = architectureSnapshot();
    const controls = mount(initial);
    editorButton('Compare options').click();
    const comparison = expectDefined(
      container.querySelector<HTMLElement>('.investigation-comparison'),
    );
    expect(editorButton('Export graph').disabled).toBe(true);
    comparison.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(container.querySelector('table')).toBeNull();
    expect(editorButton('Export graph').disabled).toBe(false);
    editorButton('Compare options').click();
    expect(editorButton('Show graph')).toBeDefined();
    controls.setSnapshot({
      ...initial,
      revision: 2,
      records: initial.records.filter((record) => record.kind !== 'option'),
    });
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('.investigation-svg')).not.toBeNull();
    expect(
      [...container.querySelectorAll('button')].some((b) => b.textContent === 'Show graph'),
    ).toBe(false);
  });
});

describe('export', () => {
  it('exports Markdown, Mermaid and JSON of the latest graph from the export menu', () => {
    const texts: string[] = [];
    const names: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => {
      void (value as Blob).text().then((text) => texts.push(text));
      return 'blob:export';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    try {
      mount(architectureSnapshot());
      editorButton('Markdown outline').click();
      editorButton('Mermaid diagram').click();
      editorButton('JSON data').click();
      expect(names).toEqual(['System-design.md', 'System-design.mmd', 'System-design.json']);
      return vi.waitFor(() => {
        expect(texts[0]).toContain('# System design · Revision 1 · Compare options · ');
        expect(texts[0]).toContain('- [option · proposed] Queue workers');
        expect(texts[1]).toContain('title: "System design · Revision 1 · Compare options · ');
        expect(texts[1]).toContain('flowchart TD');
        expect(texts[1]).toContain('["Queue workers<br/><i>option · proposed</i>"]');
        expect(JSON.parse(texts[2] ?? '{}').revision).toBe(1);
      });
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('focus and keyboard', () => {
  it('supports keyboard menus, restores trigger focus, and closes menus when hidden', () => {
    const controls = mount(architectureSnapshot());
    const trigger = editorButton('Export graph');
    trigger.click();
    expect(document.activeElement).toBe(menuButton('HTML page'));
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    expect(document.activeElement).toBe(menuButton('Markdown outline'));
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelector('[aria-label="Export format"]')).toBeNull();
    trigger.click();
    controls.setVisible(false);
    expect(document.querySelector('[aria-label="Export format"]')).toBeNull();
    controls.setVisible(true);
    trigger.click();
    controls.setKey('another-task');
    expect(document.querySelector('[aria-label="Export format"]')).toBeNull();
  });

  it('clears selection on empty canvas clicks without losing drafts or selecting a fallback node', () => {
    const controls = mount(makeFixture().snapshots[2]);
    inspect('[data-record-id="H2"]');
    editorInput('Node notes', 'Keep this unsent draft');
    const surface = expectDefined(container.querySelector<SVGSVGElement>('.investigation-svg'));
    surface.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(container.querySelector('[data-node-id][data-selected="true"]')).toBeNull();
    expect(container.querySelector('.investigation-inspector')).toBeNull();
    expect(document.activeElement).toBe(surface);
    controls.setSnapshot(makeFixture().snapshots[3]);
    click('.reasoning-graph-update');
    expect(container.querySelector('[data-node-id][data-selected="true"]')).toBeNull();
    const first = expectDefined(container.querySelector<HTMLButtonElement>('[data-record-id]'));
    expect(first.tabIndex).toBe(0);
    inspect('[data-record-id="H2"]');
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Node notes"]')?.value).toBe(
      'Keep this unsent draft',
    );
  });

  it('keeps selection for node and overlay-control clicks or prevented canvas clicks', () => {
    mount(makeFixture().snapshots[2]);
    click('[data-record-id="H2"]');
    editorButton('Fit map').click();
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    event.preventDefault();
    container.querySelector('.investigation-svg')?.dispatchEvent(event);
    expect(container.querySelector('[data-node-id="H2"]')?.getAttribute('data-selected')).toBe(
      'true',
    );
  });

  it('dismisses selected details with Escape from the selected graph card', () => {
    mount(makeFixture().snapshots[2]);
    const node = expectDefined(container.querySelector<HTMLElement>('[data-record-id="H2"]'));
    inspect('[data-record-id="H2"]');
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(container.textContent).not.toContain('NODE DETAILS');
  });

  it('disables graph controls until a graph is available and keeps note actions out of the toolbar', () => {
    mount();
    const actions = expectDefined(
      container.querySelector<HTMLFieldSetElement>('.reasoning-graph-actions'),
    );
    expect(actions.disabled).toBe(true);
    expect(container.querySelector('.reasoning-graph-toolbar')?.textContent).not.toMatch(
      /Add note|Details/,
    );
  });

  it('selects without opening a panel and shares inline creation and rename shortcuts with mind maps', async () => {
    mount(makeFixture().snapshots[2]);
    click('[data-record-id="H2"]');
    expect(container.querySelector('.investigation-inspector')).toBeNull();
    expect(canvasNode('H2').getAttribute('aria-current')).toBe('true');
    canvasNode('H2').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await Promise.resolve();
    expect(document.activeElement).toBe(inlineTitle());
    expect(inlineTitle().selectionEnd).toBe(inlineTitle().value.length);
    expect(inlineTitle().tagName).toBe('TEXTAREA');
    expect(
      document.getElementById(inlineTitle().getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('Enter saves · Tab saves and adds a child · Esc cancels');
    editorInput('Idea title', 'My hypothesis');
    canvasKey(inlineTitle(), 'Tab');
    expect(canvasNode('H2').textContent).toContain('My hypothesis');
    editorInput('Idea title', 'Check retries');
    canvasKey(inlineTitle(), 'Enter');
    expect(container.querySelector('[aria-label="Idea title"]')).toBeNull();
    canvasKey(canvasNode('H2'), 'Tab');
    expect(inlineTitle().value).toBe('New node');
    editorInput('Idea title', 'Check acknowledgements');
    inlineTitle().dispatchEvent(new FocusEvent('blur'));
    expect(
      [...container.querySelectorAll('[data-record-id^="user_"]')].map((node) => node.textContent),
    ).toEqual([
      expect.stringContaining('Check retries'),
      expect.stringContaining('Check acknowledgements'),
    ]);
    for (const shell of container.querySelectorAll('[data-node-id^="user_"]')) {
      expect(shell.getAttribute('data-kind')).toBe('idea');
      expect(shell.textContent).not.toContain('Question');
    }
    container.querySelector<HTMLButtonElement>('[aria-label="Collapse My hypothesis"]')?.click();
    expect(container.querySelector('[data-record-id^="user_"]')).toBeNull();
    container.querySelector<HTMLButtonElement>('[aria-label="Expand My hypothesis"]')?.click();
    expect(container.querySelectorAll('[data-record-id^="user_"]')).toHaveLength(2);
    canvasKey(canvasNode('H2'), 'z', { ctrlKey: true });
    expect(container.textContent).not.toContain('Check acknowledgements');
    editorButton('Redo').click();
    expect(container.textContent).toContain('Check acknowledgements');
  });

  it('lets Alt+Arrow leave inline editing without swallowing pane navigation', () => {
    mount(makeFixture().snapshots[2]);
    canvasNode('H2').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const listener = vi.fn();
    container.addEventListener('keydown', listener);
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      const event = canvasKey(inlineTitle(), key, { altKey: true });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(listener).toHaveBeenCalledTimes(4);
    container.removeEventListener('keydown', listener);
  });

  it('adds a sibling of the same kind after the note on Enter and a child on Tab', () => {
    mount(architectureSnapshot());
    canvasKey(canvasNode('queue'), 'Enter');
    expect(inlineTitle().value).toBe('New option');
    inlineTitle().dispatchEvent(new FocusEvent('blur'));
    const options = [...container.querySelectorAll('[data-node-id][data-kind="option"]')].map(
      (shell) =>
        shell.textContent?.includes('Queue workers')
          ? 'queue'
          : shell.textContent?.includes('Direct')
            ? 'direct'
            : 'new',
    );
    expect(options.slice(0, 3)).toEqual(['queue', 'new', 'direct']);
    canvasKey(canvasNode('goal'), 'Enter');
    expect(inlineTitle().value).toBe('New node');
    inlineTitle().dispatchEvent(new FocusEvent('blur'));
    expect(container.querySelectorAll('[data-record-id]')).toHaveLength(8);
    nodeMenu('[data-record-id="goal"]', 'Add child node');
    expect(inlineTitle().value).toBe('New node');
  });

  it('shows quick buttons on the selected card only and opens the full menu from them', async () => {
    const onReference = vi.fn();
    const onAsk = async () => {};
    dispose = render(
      () => (
        <ReasoningGraph
          graphKey="actions"
          snapshot={architectureSnapshot()}
          visible
          onAsk={onAsk}
          onReference={onReference}
        />
      ),
      container,
    );
    const row = (id: string) =>
      canvasNode(id).parentElement?.querySelector<HTMLElement>('.mindmap-node-actions');
    click('[data-record-id="queue"]');
    expect(row('queue')).not.toBeNull();
    expect(row('direct')).toBeNull();
    const actions = [...(row('queue')?.querySelectorAll('button') ?? [])];
    expect(actions.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Add child node',
      'More actions',
    ]);
    // Icon-only: the label lives in the hover title, not in the text.
    expect(actions.every((button) => button.title === button.getAttribute('aria-label'))).toBe(
      true,
    );
    expect(actions.every((button) => button.textContent?.trim() === '')).toBe(true);
    expect(actions.every((button) => button.querySelector('svg') !== null)).toBe(true);
    expect(actions.every((button) => button.tabIndex === -1)).toBe(true);
    const menu = () => document.querySelector('[role="menu"]');
    const item = (label: string) =>
      expectDefined(
        [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
          (entry) => entry.querySelector('span')?.textContent === label,
        ),
      );
    // The menu button opens the same menu as right-click and toggles closed again.
    actions[1].click();
    expect(menu()).not.toBeNull();
    expect(actions[1].getAttribute('aria-expanded')).toBe('true');
    actions[1].click();
    expect(menu()).toBeNull();
    actions[1].click();
    item('Reference in chat').click();
    expect(onReference).toHaveBeenCalledWith(expect.objectContaining({ id: 'queue' }), 1);
    expect(menu()).toBeNull();
    actions[1].click();
    item('Ask about this node…').click();
    expect(container.querySelector('[aria-label="Question for agent"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Node title"]')).toBeNull();
    expect(container.textContent).toContain('ASK AGENT');
    click('[aria-label="Close node details"]');
    actions[1].click();
    item('Edit details').click();
    expect(container.querySelector('.investigation-inspector')).not.toBeNull();
    expect(container.querySelector('[aria-label="Question for agent"]')).toBeNull();
    expect(container.querySelector('[aria-label="Node title"]')).not.toBeNull();
    expect(container.textContent).toContain('NODE DETAILS');
    click('[aria-label="Close node details"]');
    // The quick add moves selection to the new note; the click must not read as a canvas click.
    actions[0].click();
    await Promise.resolve();
    expect(inlineTitle().value).toBe('New node');
    expect(document.activeElement).toBe(inlineTitle());
  });
});

describe('branch focus and search', () => {
  it('focuses one branch behind a breadcrumb and returns to the whole map', () => {
    const snapshot = expectDefined(makeFixture().snapshots.at(-1));
    mount(snapshot);
    const total = shownIds().length;
    const branch = snapshot.records
      .filter((record) => nodeTrail(snapshot.records, record.id).some((step) => step.id === 'T4'))
      .map((record) => record.id);
    nodeMenu('[data-record-id="T4"]', 'Focus on this branch');
    expect([...shownIds()].sort()).toEqual([...branch].sort());
    const crumbs = expectDefined(container.querySelector('[aria-label="Focused branch"]'));
    expect(crumbs.querySelector('[aria-current]')?.textContent).toBe('Repeat the retry path');
    // The map root is the "Whole map" button; intermediate ancestors re-focus one level up.
    expect([...crumbs.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Whole map',
      'Why duplicate tasks?',
      'Retry reapplication',
    ]);
    expectDefined(
      [...crumbs.querySelectorAll('button')].find((b) => b.textContent === 'Retry reapplication'),
    ).click();
    expect(shownIds()).toContain('H22');
    expect(shownIds()).not.toContain('H1');
    nodeMenu('[data-record-id="H2"]', 'Show whole map');
    expect(container.querySelector('[aria-label="Focused branch"]')).toBeNull();
    expect(shownIds()).toHaveLength(total);
    nodeMenu('[data-record-id="H2"]', 'Focus on this branch');
    // The focused root has no visible siblings, so Enter would add a child instead.
    const openMenu = (id: string) =>
      expectDefined(container.querySelector(`[data-record-id="${id}"]`)).dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
    const menuItem = (label: string) =>
      expectDefined(
        [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
          (item) => item.querySelector('span')?.textContent === label,
        ),
      );
    const closeMenu = () =>
      document
        .querySelector('[role="menu"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    openMenu('H2');
    expect(menuItem('Add sibling node').disabled).toBe(true);
    expect(menuItem('Show whole map').disabled).toBe(false);
    closeMenu();
    // Escape on a note card leaves the branch and keeps the note.
    expectDefined(container.querySelector('[data-record-id="T4"]')).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(container.querySelector('[aria-label="Focused branch"]')).toBeNull();
    expect(shownIds()).toHaveLength(total);
    // The map root has nothing to narrow.
    openMenu('G1');
    expect(menuItem('Focus on this branch').disabled).toBe(true);
    closeMenu();
  });

  it('drops a focused branch when its root disappears or the current work lies outside it', () => {
    const fixture = makeFixture();
    const controls = mount(fixture.snapshots[5]);
    nodeMenu('[data-record-id="H1"]', 'Focus on this branch');
    expect(shownIds()).toContain('H1');
    expect(shownIds()).not.toContain('T4');
    // Find current reaches the active record even though the branch hides it.
    editorButton('Find current').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(container.querySelector('[aria-label="Focused branch"]')).toBeNull();
    expect(container.querySelector('[aria-current="true"]')?.getAttribute('data-record-id')).toBe(
      fixture.snapshots[5].activeId,
    );
    nodeMenu('[data-record-id="H1"]', 'Focus on this branch');
    controls.setSnapshot({
      ...fixture.snapshots[5],
      revision: 99,
      records: fixture.snapshots[5].records.filter((record) => record.id !== 'H1'),
    });
    expect(container.querySelector('[aria-label="Focused branch"]')).toBeNull();
    expect(shownIds()).toContain('T4');
  });

  it('finds notes by title or saved text and reveals them outside collapsed or focused branches', () => {
    const snapshot = expectDefined(makeFixture().snapshots.at(-1));
    mount(snapshot);
    branchToggle('Collapse Retry reapplication').click();
    expect(container.querySelector('[data-record-id="E21"]')).toBeNull();
    nodeMenu('[data-record-id="H1"]', 'Focus on this branch');
    const input = expectDefined(
      container.querySelector<HTMLInputElement>('[aria-label="Find nodes"]'),
    );
    const search = (text: string) => {
      input.focus();
      input.value = text;
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    };
    search('nothing like this');
    expect(
      container.querySelector('[role="status"].reasoning-graph-search-results')?.textContent,
    ).toBe('No matching notes');
    search('two rows appeared');
    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual(['Duplicate seenEvidence']);
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0].id);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(container.querySelector('[aria-label="Focused branch"]')).toBeNull();
    expect(container.querySelector('[data-record-id="E21"]')?.getAttribute('aria-current')).toBe(
      'true',
    );
    // Escape clears the search before it would leave anything else.
    search('retry');
    expect(container.querySelectorAll('[role="option"]').length).toBeGreaterThan(1);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(input.value).toBe('');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });
});
