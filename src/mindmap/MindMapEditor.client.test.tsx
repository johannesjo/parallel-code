import { expectDefined } from '../store/test-helpers';
import { createSignal } from 'solid-js';
import { createStore, unwrap } from 'solid-js/store';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MindMapEditor, type ChangeDelivery } from './MindMapEditor';
import {
  applyMapOperations,
  createMindMap,
  restoreMindMap,
  type MindMapDocument,
} from '../graph/model';
import type { BranchRequest } from '../graph/agentActions';

interface Extra {
  showOwnership?: boolean;
  sendChanges?: ChangeDelivery;
  orientation?: 'vertical' | 'horizontal';
}

let container: HTMLDivElement;
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'performance',
      'queueMicrotask',
    ],
  });
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  dispose?.();
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function mount(
  document = createMindMap(),
  onReference?: () => void,
  zoom = 1,
  onBranchRequest?: (request: BranchRequest) => void,
  initialExtra: Extra = {},
) {
  // Exercise Solid store proxies too: history must not hold mutable store references.
  const [state, setState] = createStore({ document });
  const [visible, setVisible] = createSignal(true);
  const [defaultZoom, setDefaultZoom] = createSignal(zoom);
  const [extra, setExtra] = createSignal(initialExtra);
  dispose = render(
    () => (
      <MindMapEditor
        document={state.document}
        onChange={(next) => setState('document', next)}
        visible={visible()}
        defaultZoom={defaultZoom()}
        onReference={onReference}
        onBranchRequest={onBranchRequest}
        {...extra()}
      />
    ),
    container,
  );
  vi.advanceTimersByTime(400);
  return { state, setState, setVisible, setDefaultZoom, setExtra };
}
/** Root with two agent-created branches; `a` holds `a1`, `b` holds `b1`. */
function twoBranches(): MindMapDocument {
  return {
    version: 1,
    revision: 0,
    relations: [],
    records: [
      { id: 'root', title: 'Root', detail: '' },
      { id: 'a', parent: 'root', title: 'A', detail: '' },
      { id: 'a1', parent: 'a', title: 'A1', detail: '' },
      { id: 'b', parent: 'root', title: 'B', detail: '' },
      { id: 'b1', parent: 'b', title: 'B1', detail: '' },
    ],
  };
}
const childrenOf = (document: MindMapDocument, parent: string) =>
  document.records.filter((node) => node.parent === parent).map((node) => node.id);
const record = (document: MindMapDocument, id: string) =>
  expectDefined(document.records.find((node) => node.id === id));
const input = () =>
  expectDefined(container.querySelector<HTMLTextAreaElement>('[aria-label="Idea title"]'));
const idea = (id: string) =>
  expectDefined(container.querySelector<HTMLElement>(`[data-record-id="${id}"]`));
function key(element: Element, key: string, modifiers: KeyboardEventInit = {}) {
  element.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers }),
  );
  vi.runAllTicks();
}
function type(value: string) {
  input().value = value;
  input().dispatchEvent(new Event('input', { bubbles: true }));
}
function button(text: string) {
  const result = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === text || button.getAttribute('aria-label') === text,
  );
  if (!result) throw new Error(`Missing button ${text}`);
  return result;
}
function menuItem(label: string) {
  return expectDefined(
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (item) => item.querySelector('span')?.textContent === label,
    ),
  );
}
function exportMenu() {
  button('Export map').click();
  vi.runAllTicks();
}
/** Map-wide actions moved to the toolbar; node actions come from the context menu. */
function nodeMenu(id: string) {
  context(id);
}
function dialogButton(text: string) {
  return expectDefined(
    [...document.querySelectorAll<HTMLButtonElement>('.dialog-overlay button')].find(
      (item) => item.textContent?.trim() === text,
    ),
  );
}

it('undoes a user creation without a tombstone, so the agent may reuse the idea', () => {
  const { state } = mount();
  const root = state.document.records[0].id;
  key(idea(root), 'Enter');
  type('User child');
  key(input(), 'Enter');
  const child = expectDefined(state.document.records.find((node) => node.parent === root));
  const node = { id: child.id, parent: root, title: child.title, detail: child.detail };
  button('Undo').click();
  button('Undo').click();
  expect(state.document.userDeleted?.records ?? []).not.toContain(node.id);
  const document = structuredClone(unwrap(state.document));
  const next = applyMapOperations(document, [{ type: 'insert', node }], document.revision, 'agent');
  expect(next.records.map((record) => record.id)).toContain(node.id);
});

it('leaves agent ideas editable by the agent again after undoing a rename or deletion', () => {
  const map = createMindMap('Root');
  const root = map.records[0].id;
  map.records.push(
    { id: 'agent', parent: root, title: 'Agent idea', detail: '' },
    { id: 'leaf', parent: 'agent', title: 'Leaf', detail: '' },
  );
  const { state } = mount(map);
  key(idea('leaf'), 'F2');
  type('Renamed by user');
  key(input(), 'Enter');
  expect(state.document.records.find((node) => node.id === 'leaf')?.userEdited).toEqual(['title']);
  button('Undo').click();
  expect(state.document.records.find((node) => node.id === 'leaf')?.userEdited).toBeUndefined();
  key(idea('agent'), 'Delete');
  dialogButton('Delete branch').click();
  vi.runAllTicks();
  expect(state.document.records.map((node) => node.id)).toEqual([root]);
  expect(state.document.userDeleted?.records).toContain('agent');
  button('Undo').click();
  expect(state.document.records.map((node) => node.id)).toEqual([root, 'agent', 'leaf']);
  expect(state.document.userDeleted?.records ?? []).not.toContain('agent');
  expect(state.document.records.find((node) => node.id === root)?.userEdited).toBeUndefined();
  const document = structuredClone(unwrap(state.document));
  const agentEdit = applyMapOperations(
    document,
    [{ type: 'update', id: 'leaf', changes: { title: 'Agent again' } }],
    document.revision,
    'agent',
  );
  expect(agentEdit.records.find((node) => node.id === 'leaf')?.title).toBe('Agent again');
});
function context(id: string) {
  idea(id).dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }),
  );
  vi.runAllTicks();
}

function typeChoice(label: string) {
  return expectDefined(
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
      (item) => item.querySelector('span')?.textContent === label,
    ),
  );
}

it('opens the type flyout on hover alongside the main menu without stealing focus', () => {
  const { state } = mount();
  context(state.document.records[0].id);
  const before = document.activeElement;
  menuItem('Node type').dispatchEvent(new PointerEvent('pointerenter'));
  expect(document.querySelectorAll('[role="menu"]')).toHaveLength(2);
  expect(menuItem('Rename')).toBeDefined();
  expect(typeChoice('Plain')).toBeDefined();
  expect(document.activeElement).toBe(before);
  typeChoice('Goal').click();
  expect(state.document.records[0].kind).toBe('goal');
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it('starts at the side-panel zoom, switches layout without editing data, and references the clicked node', () => {
  const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  const map = createMindMap();
  map.records.push({ id: 'child', parent: map.records[0].id, title: 'Child', detail: 'Context' });
  const reference = vi.fn();
  // Vertical camera math is asserted below; maps default to horizontal.
  const { state, setDefaultZoom, setExtra } = mount(map, reference, 0.7, undefined, {
    orientation: 'vertical',
  });
  const camera = () => container.querySelector('svg > g')?.getAttribute('transform');
  expect(camera()).toContain('scale(0.7)');
  width.mockReturnValue(0);
  setDefaultZoom(1);
  width.mockReturnValue(1000);
  vi.advanceTimersByTime(500);
  expect(camera()).toContain('scale(1)');
  expect(camera()).toContain('translate(500,');
  width.mockReturnValue(0);
  setDefaultZoom(0.7);
  width.mockReturnValue(400);
  vi.advanceTimersByTime(500);
  expect(camera()).toContain('scale(0.7)');
  expect(camera()).toContain('translate(200,');
  expect(container.querySelector('[aria-label="Switch to horizontal layout"]')).not.toBeNull();
  setExtra({ orientation: 'horizontal' });
  vi.advanceTimersByTime(500);
  expect(container.querySelector('[data-orientation]')?.getAttribute('data-orientation')).toBe(
    'horizontal',
  );
  const x = (id: string) => Number(idea(id).closest('foreignObject')?.getAttribute('x'));
  expect(x('child')).toBeGreaterThan(x(map.records[0].id));
  expect(state.document.revision).toBe(0);
  context('child');
  menuItem('Reference in chat').click();
  expect(reference).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'child', detail: 'Context' }),
  );
  expect(state.document.revision).toBe(0);
});

it('chooses types from the context menu, restores Plain, and undoes type changes', () => {
  const { state } = mount();
  const root = state.document.records[0].id;
  const shell = () => idea(root).closest('[data-kind]');
  expect(shell()?.getAttribute('data-kind')).toBe('idea');
  expect(idea(root).querySelector('.investigation-node-symbol')?.textContent).toBe('');
  context(root);
  menuItem('Node type').focus();
  key(menuItem('Node type'), 'ArrowRight');
  expect(typeChoice('Plain').getAttribute('aria-checked')).toBe('true');
  expect(document.activeElement).toBe(typeChoice('Plain'));
  typeChoice('Question').click();
  vi.runAllTicks();
  expect(state.document.records[0].kind).toBe('question');
  expect(shell()?.getAttribute('data-kind')).toBe('question');
  expect(idea(root).querySelector('.investigation-node-symbol')?.textContent).toBe('?');
  expect(document.activeElement).toBe(idea(root));
  button('Undo').click();
  expect(state.document.records[0].kind).toBeUndefined();
  expect(shell()?.getAttribute('data-kind')).toBe('idea');
  button('Redo').click();
  expect(state.document.records[0].kind).toBe('question');
  context(root);
  menuItem('Node type').click();
  typeChoice('Plain').click();
  // Plain is the absent default; returning to it must not store kind: 'idea'.
  expect(state.document.records[0].kind).toBeUndefined();
  expect(idea(root).querySelector('.investigation-node-symbol')?.textContent).toBe('');
});

it('backs out of the type picker without changing the node and creates plain children of typed nodes', () => {
  const map = createMindMap();
  map.records[0].kind = 'goal';
  const { state } = mount(map);
  const root = state.document.records[0].id;
  context(root);
  menuItem('Node type').click();
  key(typeChoice('Goal'), 'Escape');
  expect(menuItem('Node type')).toBe(document.activeElement);
  expect(state.document.records[0].kind).toBe('goal');
  menuItem('Add child').click();
  key(input(), 'Enter');
  expect(state.document.records[1].kind).toBeUndefined();
});

it('edits the right-clicked node through the context menu and preserves deletion undo', () => {
  const { state } = mount();
  const root = state.document.records[0].id;
  context(root);
  expect(menuItem('Delete branch').disabled).toBe(true);
  expect(menuItem('Add sibling').disabled).toBe(true);
  menuItem('Add child').click();
  vi.runAllTicks();
  type('Child');
  key(input(), 'Enter');
  const child = state.document.records[1].id;
  idea(root).focus();
  context(child);
  expect(idea(child).getAttribute('aria-current')).toBe('true');
  expect(idea(child).hasAttribute('aria-pressed')).toBe(false);
  menuItem('Rename').click();
  vi.runAllTicks();
  expect(document.activeElement).toBe(input());
  type('Renamed');
  key(input(), 'Enter');
  context(child);
  menuItem('Edit notes').click();
  vi.runAllTicks();
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Idea notes');
  context(child);
  menuItem('Delete branch').click();
  vi.runAllTicks();
  expect(state.document.records).toHaveLength(1);
  expect(document.querySelector('[role="menu"]')).toBeNull();
  button('Undo').click();
  expect(state.document.records[1].title).toBe('Renamed');
});

it('supports keyboard context menus and dismisses them on Escape, outside clicks, and hidden canvases', () => {
  const { state, setVisible } = mount();
  const root = state.document.records[0].id;
  key(idea(root), 'F10', { shiftKey: true });
  expect(document.activeElement).toBe(menuItem('Rename'));
  key(menuItem('Rename'), 'End');
  expect(document.activeElement).toBe(menuItem('Add child'));
  key(menuItem('Add child'), 'ArrowDown');
  expect(document.activeElement).toBe(menuItem('Rename'));
  key(menuItem('Rename'), 'Escape');
  expect(document.activeElement).toBe(idea(root));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  key(idea(root), 'ContextMenu');
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  context(root);
  setVisible(false);
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it('starts without an agent, edits inline, and creates children and siblings with the keyboard', () => {
  const { state } = mount();
  const root = state.document.records[0].id;
  idea(root).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  vi.runAllTicks();
  expect(document.activeElement).toBe(input());
  type('Release plan');
  key(input(), 'Tab');
  expect(state.document.records[0].title).toBe('Release plan');
  expect(state.document.records).toHaveLength(2);
  expect(document.activeElement).toBe(input());
  type('Documentation');
  key(input(), 'Enter');
  expect(state.document.records).toHaveLength(2);
  expect(document.activeElement).toBe(idea(state.document.records[1].id));
  button('Sibling').click();
  vi.runAllTicks();
  expect(state.document.records.filter((node) => node.parent === root)).toHaveLength(2);
  type('Testing');
  input().dispatchEvent(new FocusEvent('blur'));
  expect(state.document.records.map((node) => node.title)).toEqual([
    'Release plan',
    'Documentation',
    'Testing',
  ]);
  expect(container.textContent).not.toContain('Connect agent');
});

it('cancels a title, honors IME composition, and leaves Shift+Tab available', () => {
  const { state } = mount();
  const root = state.document.records[0].id;
  key(idea(root), 'F2');
  type('Unfinished');
  key(input(), 'Enter', { isComposing: true });
  expect(state.document.records).toHaveLength(1);
  key(input(), 'Escape');
  expect(state.document.records[0].title).toBe('Central topic');
  expect(document.activeElement).toBe(idea(root));
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  idea(root).dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
});

it('undoes and redoes title edits and node insertion without mutating history', () => {
  const { state } = mount();
  button('Idea').click();
  vi.runAllTicks();
  type('First idea');
  input().dispatchEvent(new FocusEvent('blur'));
  const id = state.document.records[1].id;
  button('Undo').click();
  expect(state.document.records[1].title).toBe('New idea');
  button('Undo').click();
  expect(state.document.records).toHaveLength(1);
  button('Redo').click();
  button('Redo').click();
  expect(state.document.records[1]).toMatchObject({ id, title: 'First idea' });
  expect(state.document.revision).toBe(6);
});

it('moves and removes branches, then restores them with undo', () => {
  const { state } = mount();
  button('Idea').click();
  vi.runAllTicks();
  type('A');
  key(input(), 'Enter');
  button('Sibling').click();
  vi.runAllTicks();
  type('B');
  input().dispatchEvent(new FocusEvent('blur'));
  const [root, a, b] = state.document.records.map((node) => node.id);
  nodeMenu(b);
  menuItem('Nest under previous idea').click();
  expect(state.document.records.find((node) => node.id === b)?.parent).toBe(a);
  nodeMenu(b);
  menuItem('Move one level up').click();
  expect(state.document.records.find((node) => node.id === b)?.parent).toBe(root);
  key(idea(b), 'Delete');
  expect(state.document.records).toHaveLength(2);
  button('Undo').click();
  expect(state.document.records).toHaveLength(3);
});

it('keeps IDs and notes through persistence and visibility changes', () => {
  const { state, setVisible } = mount();
  button('Idea').click();
  vi.runAllTicks();
  type('Keep me');
  input().dispatchEvent(new FocusEvent('blur'));
  nodeMenu(state.document.records[1].id);
  menuItem('Edit notes').click();
  const notes = expectDefined(
    container.querySelector<HTMLTextAreaElement>('[aria-label="Idea notes"]'),
  );
  notes.value = 'Supporting details';
  notes.dispatchEvent(new Event('change', { bubbles: true }));
  expect(idea(state.document.records[1].id).querySelector('[title="Has notes"]')).not.toBeNull();
  expect(idea(state.document.records[1].id).getAttribute('aria-label')).toContain('Has notes.');
  const saved = JSON.parse(JSON.stringify(unwrap(state.document)));
  setVisible(false);
  setVisible(true);
  expect(restoreMindMap(saved)?.records[1]).toMatchObject({
    title: 'Keep me',
    detail: 'Supporting details',
  });
  expect(state.document.records).toEqual(saved.records);
  notes.value = '  ';
  notes.dispatchEvent(new Event('change', { bubbles: true }));
  expect(idea(state.document.records[1].id).querySelector('[title="Has notes"]')).toBeNull();
});

it('creates children with Tab and siblings with Enter, saves while editing, and confirms branch deletion', () => {
  const { state } = mount();
  const root = state.document.records[0].id;
  key(idea(root), 'Enter');
  type('Child');
  key(input(), 'Enter');
  const child = state.document.records[1].id;
  expect(document.activeElement).toBe(idea(child));
  key(idea(child), 'Enter');
  expect(state.document.records[2].parent).toBe(root);
  key(input(), 'Escape');
  button('Undo').click();
  key(idea(child), 'Tab');
  expect(state.document.records[2].parent).toBe(child);
  type('Grandchild');
  for (const key of ['Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    input().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(state.document.records).toHaveLength(3);
  }
  key(input(), 'Enter');
  expect(state.document.records).toHaveLength(3);
  key(idea(root), 'Delete');
  expect(state.document.records).toHaveLength(3);
  key(idea(child), 'Delete');
  expect(state.document.records).toHaveLength(3);
  expect(document.querySelector('.dialog-overlay')?.textContent).toContain('1 ideas below');
  dialogButton('Cancel').click();
  vi.runAllTicks();
  expect(document.querySelector('.dialog-overlay')).toBeNull();
  expect(document.activeElement).toBe(idea(child));
  key(idea(child), 'Backspace');
  dialogButton('Delete branch').click();
  vi.runAllTicks();
  expect(state.document.records).toHaveLength(1);
  expect(document.activeElement).toBe(idea(root));
  button('Undo').click();
  expect(state.document.records.map((node) => node.title)).toEqual([
    'Central topic',
    'Child',
    'Grandchild',
  ]);
});

it('navigates visually between siblings and depths instead of following record order or collapsing', () => {
  mount(
    {
      version: 1,
      revision: 0,
      relations: [],
      records: [
        { id: 'root', title: 'Root', detail: '' },
        { id: 'left', parent: 'root', title: 'Left', detail: '' },
        { id: 'left-child', parent: 'left', title: 'Left child', detail: '' },
        { id: 'right', parent: 'root', title: 'Right', detail: '' },
        { id: 'right-child', parent: 'right', title: 'Right child', detail: '' },
      ],
    },
    undefined,
    1,
    undefined,
    { orientation: 'vertical' },
  );
  idea('left').focus();
  for (const [direction, target] of [
    ['ArrowRight', 'right'],
    ['ArrowLeft', 'left'],
    ['ArrowDown', 'left-child'],
    ['ArrowUp', 'left'],
  ]) {
    key(expectDefined(document.activeElement), direction);
    expect(document.activeElement).toBe(idea(target));
    expect(idea(target).getAttribute('aria-current')).toBe('true');
  }
  expect(idea('left-child')).toBeDefined();
  idea('root').focus();
  key(idea('root'), 'ArrowUp');
  expect(document.activeElement).toBe(idea('root'));
  container.querySelector<HTMLButtonElement>('[aria-label="Collapse Left"]')?.click();
  vi.advanceTimersByTime(400);
  key(idea('left'), 'ArrowDown');
  expect(document.activeElement).toBe(idea('right-child'));
  expect(container.querySelector('[data-record-id="left-child"]')).toBeNull();
});

it('keeps an invalid title in the editor without modifying the document', () => {
  const { state } = mount();
  key(idea(state.document.records[0].id), 'F2');
  type(' ');
  key(input(), 'Tab');
  expect(state.document.records).toHaveLength(1);
  expect(input().value).toBe(' ');
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});

it('places the caret after the first typed character and supports explicit collapse and keyboard exit', () => {
  const { state } = mount();
  const root = state.document.records[0].id;
  key(idea(root), 'R');
  expect(input().value).toBe('R');
  expect(input().selectionStart).toBe(1);
  expect(input().selectionEnd).toBe(1);
  key(input(), 'Escape');
  button('Idea').click();
  vi.runAllTicks();
  key(input(), 'Escape');
  const child = state.document.records[1].id;
  container.querySelector<HTMLButtonElement>('[aria-label="Collapse Central topic"]')?.click();
  expect(container.querySelector(`[data-record-id="${child}"]`)).toBeNull();
  container.querySelector<HTMLButtonElement>('[aria-label="Expand Central topic"]')?.click();
  vi.runAllTicks();
  expect(idea(child)).toBeDefined();
  key(idea(root), 'Escape');
  expect(document.activeElement).toBe(button('Idea'));
});

it('does not undo over external revisions or overwrite a conflicting inline title', () => {
  const { state, setState } = mount();
  button('Idea').click();
  vi.runAllTicks();
  type('Local title');
  const child = state.document.records[1].id;
  setState('document', {
    ...unwrap(state.document),
    revision: state.document.revision + 1,
    records: state.document.records.map((node) => ({
      ...node,
      title: node.id === child ? 'External title' : node.title,
    })),
  });
  key(input(), 'Enter');
  expect(state.document.records).toHaveLength(2);
  expect(state.document.records[1].title).toBe('External title');
  expect(input().value).toBe('Local title');
  expect(button('Undo').disabled).toBe(true);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('changed');
});

it('retains a focused notes draft when an agent changes its detail and rejects conflicting blur', () => {
  const { state, setState } = mount();
  nodeMenu(state.document.records[0].id);
  menuItem('Edit notes').click();
  const notes = expectDefined(
    container.querySelector<HTMLTextAreaElement>('[aria-label="Idea notes"]'),
  );
  notes.focus();
  notes.value = 'My unfinished notes';
  notes.dispatchEvent(new Event('input', { bubbles: true }));
  setState('document', {
    ...unwrap(state.document),
    revision: state.document.revision + 1,
    records: state.document.records.map((node) => ({ ...node, detail: 'Agent notes' })),
  });
  expect(notes.value).toBe('My unfinished notes');
  notes.dispatchEvent(new Event('change', { bubbles: true }));
  expect(state.document.records[0].detail).toBe('Agent notes');
  expect(notes.value).toBe('My unfinished notes');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('notes changed');
  key(notes, 'Escape');
  expect(notes.value).toBe('Agent notes');
  notes.value = 'Reviewed notes';
  notes.dispatchEvent(new Event('input', { bubbles: true }));
  notes.dispatchEvent(new Event('change', { bubbles: true }));
  expect(state.document.records[0].detail).toBe('Reviewed notes');
});

it('drops notes for an idea the agent removed and says so instead of saving them elsewhere', () => {
  const { state, setState } = mount(twoBranches());
  idea('a').click();
  nodeMenu('a');
  menuItem('Edit notes').click();
  const notes = expectDefined(
    container.querySelector<HTMLTextAreaElement>('[aria-label="Idea notes"]'),
  );
  notes.focus();
  notes.value = 'Notes for A';
  notes.dispatchEvent(new Event('input', { bubbles: true }));
  setState('document', {
    ...unwrap(state.document),
    revision: 1,
    records: state.document.records.filter((node) => !node.id.startsWith('a')),
  });
  vi.runAllTicks();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('removed');
  const fallback = expectDefined(
    container.querySelector<HTMLTextAreaElement>('[aria-label="Idea notes"]'),
  );
  expect(fallback.value).toBe('');
  fallback.dispatchEvent(new Event('change', { bubbles: true }));
  expect(record(state.document, 'root').detail).toBe('');
  dispose?.();
  dispose = undefined;
  expect(state.document.records.every((node) => node.detail === '')).toBe(true);
});

it('explains an empty title and how to cancel it instead of quoting the model error', () => {
  const { state } = mount(twoBranches());
  key(idea('a'), 'F2');
  type('   ');
  key(input(), 'Enter');
  const alert = () => container.querySelector('[role="alert"]')?.textContent ?? '';
  expect(alert()).toMatch(/title/i);
  expect(alert()).toContain('Escape');
  expect(alert()).not.toContain('Expected');
  key(idea('b'), 'F2');
  expect(input().value).toBe('   ');
  expect(alert()).toContain('Escape');
  key(input(), 'Escape');
  key(idea('b'), 'F2');
  expect(input().value).toBe('B');
  expect(record(state.document, 'a').title).toBe('A');
});

it('does not announce agent ideas as new again when undo or redo restores them', () => {
  const { state, setState } = mount(twoBranches());
  const fresh = (id: string) => idea(id).closest('[data-fresh]')?.getAttribute('data-fresh');
  setState('document', {
    ...unwrap(state.document),
    revision: 1,
    records: [...state.document.records, { id: 'c', parent: 'root', title: 'C', detail: '' }],
  });
  vi.runAllTicks();
  expect(fresh('c')).toBe('true');
  vi.advanceTimersByTime(3000);
  expect(fresh('c')).toBe('false');
  key(idea('c'), 'Delete');
  vi.runAllTicks();
  expect(container.querySelector('[data-record-id="c"]')).toBeNull();
  button('Undo').click();
  vi.runAllTicks();
  expect(fresh('c')).toBe('false');
  button('Redo').click();
  button('Undo').click();
  vi.runAllTicks();
  expect(fresh('c')).toBe('false');
});

it('offers shared branch actions and includes collapsed descendants in their context', () => {
  const request = vi.fn<(request: BranchRequest) => void>();
  const map = {
    version: 1 as const,
    revision: 3,
    records: [
      { id: 'root', title: 'Root', detail: '' },
      { id: 'branch', parent: 'root', title: 'Branch', detail: 'Saved notes' },
      { id: 'child', parent: 'branch', title: 'Hidden child', detail: '' },
    ],
    relations: [],
  };
  mount(map, undefined, 1, request);
  context('branch');
  menuItem('Collapse branch').click();
  for (const [label, intent] of [
    ['Explain this branch', 'explain'],
    ['Expand with ideas', 'expand'],
    ['Investigate this branch', 'investigate'],
    ['Challenge this node', 'challenge'],
  ]) {
    context('branch');
    menuItem('Send branch to agent').click();
    menuItem(label).click();
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({ intent, rootId: 'branch', revision: 3 }),
    );
  }
  expect(request.mock.calls[0][0].map.records.some((node) => node.id === 'child')).toBe(true);
});

it('drops an inline title when an agent removes the edited node and keeps editing usable', () => {
  const { state, setState } = mount();
  button('Idea').click();
  vi.runAllTicks();
  type('Doomed');
  const [root, child] = state.document.records.map((node) => node.id);
  idea(root); // the child is selected and under edit
  setState('document', {
    ...unwrap(state.document),
    revision: state.document.revision + 1,
    records: state.document.records.filter((node) => node.id !== child),
  });
  vi.runAllTicks();
  expect(container.querySelector('[aria-label="Idea title"]')).toBeNull();
  expect(document.activeElement).toBe(idea(root));
  button('Idea').click();
  vi.runAllTicks();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(state.document.records).toHaveLength(2);
  expect(input().value).toBe('New idea');
});

it('keeps collapsed branches through undo and redo, revealing only the restored selection', () => {
  const { state } = mount();
  const root = state.document.records[0].id;
  button('Idea').click();
  vi.runAllTicks();
  type('A');
  key(input(), 'Enter');
  key(idea(state.document.records[1].id), 'Tab');
  vi.runAllTicks();
  type('A1');
  key(input(), 'Enter');
  const [, a, a1] = state.document.records.map((node) => node.id);
  key(idea(root), 'Enter');
  vi.runAllTicks();
  type('B');
  key(input(), 'Enter');
  const b = state.document.records[3].id;
  container.querySelector<HTMLButtonElement>('[aria-label="Collapse A"]')?.click();
  expect(container.querySelector(`[data-record-id="${a1}"]`)).toBeNull();
  key(idea(b), 'F2');
  type('B renamed');
  key(input(), 'Enter');
  button('Undo').click();
  vi.runAllTicks();
  expect(state.document.records[3].title).toBe('B');
  expect(container.querySelector(`[data-record-id="${a1}"]`)).toBeNull();
  button('Redo').click();
  vi.runAllTicks();
  expect(container.querySelector(`[data-record-id="${a1}"]`)).toBeNull();
  // Undoing the removal of a node inside the collapsed branch reveals that branch.
  container.querySelector<HTMLButtonElement>('[aria-label="Expand A"]')?.click();
  vi.runAllTicks();
  key(idea(a1), 'Delete');
  container.querySelector<HTMLButtonElement>('[aria-label="Collapse A"]')?.click();
  button('Undo').click();
  vi.runAllTicks();
  expect(idea(a1)).toBeDefined();
  expect(idea(a).getAttribute('aria-label')).toContain('A.');
});

it('disables sibling creation at the root and closes the export menu after Escape, outside clicks, or a second click', () => {
  const { state } = mount();
  const root = state.document.records[0].id;
  expect(button('Sibling').disabled).toBe(true);
  exportMenu();
  expect(button('Export map').getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement).toBe(menuItem('HTML page'));
  key(menuItem('HTML page'), 'Escape');
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(button('Export map'));
  exportMenu();
  idea(root).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  // Clicking the button while open toggles the menu closed instead of reopening it.
  exportMenu();
  button('Export map').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  exportMenu();
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it('shows titles rather than IDs in the hover preview and node labels, and reports layout changes', () => {
  const onOrientationChange = vi.fn();
  const document = createMindMap('Root');
  document.records.push({
    id: 'n1',
    parent: document.records[0].id,
    title: 'Child',
    detail: 'Some notes',
    kind: 'goal',
  });
  const [state] = createStore({ document });
  dispose = render(
    () => (
      <MindMapEditor
        document={state.document}
        onChange={() => {}}
        visible
        orientation="vertical"
        onOrientationChange={onOrientationChange}
      />
    ),
    container,
  );
  vi.advanceTimersByTime(400);
  const label = idea('n1').getAttribute('aria-label') ?? '';
  expect(label.startsWith('Goal: Child.')).toBe(true);
  expect(label).not.toContain('n1');
  idea('n1').dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
  vi.runAllTicks();
  const preview = container.querySelector('.investigation-preview small')?.textContent ?? '';
  expect(preview).toContain('Root');
  expect(preview).not.toContain(document.records[0].id);
  button('↕ Vertical').click();
  expect(onOrientationChange).toHaveBeenCalledWith('horizontal');
  // Controlled by the parent: the label only changes once the prop does.
  expect(button('↕ Vertical')).toBeDefined();
});

it('outdents with Shift+Tab only where possible and reorders siblings with Alt+Shift+arrows', () => {
  const { state } = mount(twoBranches());
  idea('a1').focus();
  const outdent = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  idea('a1').dispatchEvent(outdent);
  vi.runAllTicks();
  expect(outdent.defaultPrevented).toBe(true);
  expect(record(state.document, 'a1').parent).toBe('root');
  expect(childrenOf(state.document, 'root')).toEqual(['a', 'a1', 'b']);
  expect(document.activeElement).toBe(idea('a1'));
  // Top-level ideas cannot go higher: reverse Tab keeps its native meaning.
  const native = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  idea('a1').dispatchEvent(native);
  expect(native.defaultPrevented).toBe(false);
  key(idea('a1'), 'ArrowDown', { altKey: true, shiftKey: true });
  expect(childrenOf(state.document, 'root')).toEqual(['a', 'b', 'a1']);
  key(idea('a1'), 'ArrowUp', { altKey: true, shiftKey: true });
  key(idea('a1'), 'ArrowUp', { altKey: true, shiftKey: true });
  expect(childrenOf(state.document, 'root')).toEqual(['a1', 'a', 'b']);
  // Pane navigation keeps plain Alt+Arrow.
  const pane = new KeyboardEvent('keydown', {
    key: 'ArrowUp',
    altKey: true,
    bubbles: true,
    cancelable: true,
  });
  idea('a1').dispatchEvent(pane);
  expect(pane.defaultPrevented).toBe(false);
  button('Undo').click();
  button('Undo').click();
  button('Undo').click();
  expect(childrenOf(state.document, 'root')).toEqual(['a', 'a1', 'b']);
  key(idea('a1'), 'y', { ctrlKey: true });
  expect(childrenOf(state.document, 'root')).toEqual(['a', 'b', 'a1']);
});

it('zooms on plus and minus instead of starting a title, and clears errors on reselection', () => {
  const { state } = mount(twoBranches());
  const camera = () => container.querySelector('svg > g')?.getAttribute('transform') ?? '';
  key(idea('a'), '+');
  expect(container.querySelector('[aria-label="Idea title"]')).toBeNull();
  expect(camera()).toContain('scale(1.2');
  key(idea('a'), '-');
  expect(camera()).toContain('scale(1)');
  key(idea('a'), 'F2');
  type(' ');
  key(input(), 'Tab');
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  idea('b').click();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(state.document.revision).toBe(0);
});

it('keeps the selection reachable when its branch collapses or an agent moves it out of view', () => {
  const { state, setState } = mount(twoBranches());
  idea('a1').click();
  container.querySelector<HTMLButtonElement>('[aria-label="Collapse A"]')?.click();
  vi.runAllTicks();
  expect(idea('a').getAttribute('aria-current')).toBe('true');
  expect(document.activeElement).toBe(idea('a'));
  container.querySelector<HTMLButtonElement>('[aria-label="Collapse B"]')?.click();
  container.querySelector<HTMLButtonElement>('[aria-label="Expand A"]')?.click();
  vi.runAllTicks();
  idea('a1').click();
  setState('document', {
    ...unwrap(state.document),
    revision: 1,
    records: state.document.records.map((node) =>
      node.id === 'a1' ? { ...node, parent: 'b' } : node,
    ),
  });
  vi.runAllTicks();
  expect(container.querySelector('[data-record-id="a1"]')).toBeNull();
  expect(idea('b').getAttribute('aria-current')).toBe('true');
});

it('does not pull focus into the map when nothing in the app is focused', () => {
  const { state, setState } = mount(twoBranches());
  idea('a').click();
  (document.activeElement as HTMLElement | null)?.blur();
  expect(document.activeElement).toBe(document.body);
  setState('document', {
    ...unwrap(state.document),
    revision: 1,
    records: state.document.records.filter((node) => !node.id.startsWith('a')),
  });
  vi.runAllTicks();
  expect(idea('root').getAttribute('aria-current')).toBe('true');
  expect(document.activeElement).toBe(document.body);
});

it('saves an unfinished title and notes when the editor unmounts', () => {
  const { state } = mount(twoBranches());
  nodeMenu(state.document.records[0].id);
  menuItem('Edit notes').click();
  const notes = expectDefined(
    container.querySelector<HTMLTextAreaElement>('[aria-label="Idea notes"]'),
  );
  notes.value = 'Half-written note';
  notes.dispatchEvent(new Event('input', { bubbles: true }));
  key(idea('a'), 'F2');
  type('Half-written title');
  dispose?.();
  dispose = undefined;
  expect(record(state.document, 'a').title).toBe('Half-written title');
  expect(record(state.document, 'root').detail).toBe('Half-written note');
});

it('keeps the context menu and its focus when the document changes underneath it', () => {
  const { state, setState } = mount(twoBranches());
  context('a');
  const rename = menuItem('Rename');
  expect(document.activeElement).toBe(rename);
  setState('document', {
    ...unwrap(state.document),
    revision: 1,
    records: [...state.document.records, { id: 'c', parent: 'root', title: 'C', detail: '' }],
  });
  vi.runAllTicks();
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  expect(menuItem('Rename')).toBe(rename);
  expect(document.activeElement).toBe(rename);
});

it('shows subtle ownership marks and releases ideas to the agent only when enabled', () => {
  const map = twoBranches();
  record(map, 'a').userEdited = ['title', 'detail'];
  record(map, 'b1').userEdited = ['*'];
  const { state, setExtra } = mount(map, undefined, 1, undefined, { showOwnership: true });
  const mark = (id: string) => idea(id).querySelector<HTMLElement>('.mindmap-ownership');
  expect(mark('a')?.getAttribute('title')).toBe(
    'Edited by you: title, notes. The agent keeps these unless it overrides.',
  );
  expect(mark('b1')?.getAttribute('title')).toBe(
    'Created by you. The agent keeps it unless it overrides.',
  );
  expect(mark('b')).toBeNull();
  expect(idea('a').getAttribute('aria-label')).toContain('Edited by you.');
  context('a');
  menuItem('Release to agent').click();
  vi.runAllTicks();
  expect(record(state.document, 'a').userEdited).toBeUndefined();
  expect(mark('a')).toBeNull();
  button('Undo').click();
  expect(record(state.document, 'a').userEdited).toEqual(['title', 'detail']);
  button('Release all').click();
  vi.runAllTicks();
  expect(state.document.records.some((node) => node.userEdited)).toBe(false);
  expect(
    [...container.querySelectorAll('button')].map((item) => item.textContent?.trim()),
  ).not.toContain('Release all');
  setExtra({ showOwnership: false });
  button('Undo').click();
  expect(record(state.document, 'a').userEdited).toEqual(['title', 'detail']);
  expect(mark('a')).toBeNull();
  context('a');
  expect(
    [...document.querySelectorAll('[role="menuitem"] span')].map((span) => span.textContent),
  ).not.toContain('Release to agent');
});

it('clears the selection when the canvas background is clicked and still adds from the toolbar', () => {
  const { state } = mount(twoBranches());
  const muted = (id: string) =>
    idea(id).closest('.investigation-node-shell')?.getAttribute('data-muted');
  idea('a').click();
  vi.runAllTicks();
  expect(muted('b1')).toBe('true');
  expect(idea('a').getAttribute('aria-current')).toBe('true');
  // A click on a node reaches the canvas too, so only a real background hit clears.
  expectDefined(container.querySelector<SVGSVGElement>('.investigation-svg')).dispatchEvent(
    new MouseEvent('click', { bubbles: true }),
  );
  vi.runAllTicks();
  expect(['root', 'a', 'a1', 'b', 'b1'].map(muted)).toEqual([
    'false',
    'false',
    'false',
    'false',
    'false',
  ]);
  expect(idea('a').getAttribute('aria-current')).toBeNull();
  // Nothing selected still adds: the new idea joins the central topic.
  button('Idea').click();
  vi.runAllTicks();
  expect(childrenOf(state.document, 'root')).toHaveLength(3);
});

it('keeps the selection cleared when the agent changes the map', () => {
  const { state, setState } = mount(twoBranches());
  const muted = (id: string) =>
    idea(id).closest('.investigation-node-shell')?.getAttribute('data-muted');
  idea('a').click();
  vi.runAllTicks();
  expectDefined(container.querySelector<SVGSVGElement>('.investigation-svg')).dispatchEvent(
    new MouseEvent('click', { bubbles: true }),
  );
  vi.runAllTicks();
  expect(idea('a').getAttribute('aria-current')).toBeNull();
  setState('document', {
    ...unwrap(state.document),
    revision: state.document.revision + 1,
    records: [
      ...unwrap(state.document).records,
      { id: 'c', parent: 'root', title: 'C', detail: '' },
    ],
  });
  vi.runAllTicks();
  // Nothing may re-select the central topic behind the user's back and dim the map again.
  expect(container.querySelector('[aria-current="true"]')).toBeNull();
  expect(['root', 'a', 'a1', 'b', 'b1', 'c'].map(muted)).toEqual(Array(6).fill('false'));
});

it('dims ideas outside the selected one, its parent and its children', () => {
  mount(twoBranches());
  const muted = (id: string) =>
    idea(id).closest('.investigation-node-shell')?.getAttribute('data-muted');
  idea('a').click();
  vi.runAllTicks();
  expect(['a', 'root', 'a1'].map(muted)).toEqual(['false', 'false', 'false']);
  expect(['b', 'b1'].map(muted)).toEqual(['true', 'true']);
  idea('b').click();
  vi.runAllTicks();
  expect(['b', 'root', 'b1'].map(muted)).toEqual(['false', 'false', 'false']);
  expect(['a', 'a1'].map(muted)).toEqual(['true', 'true']);
});

it('exports the map as a self-contained HTML page built from the live canvas', async () => {
  mount(twoBranches());
  const svg = expectDefined(container.querySelector<SVGSVGElement>('.investigation-svg'));
  const group = expectDefined(svg.querySelector('g'));
  // happy-dom has no layout, so the export's fit-to-bounds needs a measured box.
  Object.assign(group, { getBBox: () => ({ x: 0, y: 0, width: 400, height: 200 }) });
  let blob: Blob | undefined;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => {
    blob = value as Blob;
    return 'blob:map';
  });
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  let filename = '';
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    filename = this.download;
  });
  exportMenu();
  menuItem('HTML page').click();
  expect(filename).toBe('Root.html');
  const html = await blob?.text();
  expect(html).toContain('viewBox="-24 -24 448 248"');
  expect(html).toContain('Revision 0 · ');
  const saved = new DOMParser().parseFromString(html ?? '', 'text/html');
  expect(saved.querySelector('svg')).not.toBeNull();
  expect(JSON.parse(saved.querySelector('pre')?.textContent ?? '{}').format).toBe(
    'parallel-code-mind-map',
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(revoke).toHaveBeenCalledWith('blob:map');
});

it('exports the map as a Markdown outline, Mermaid diagram or JSON from the toolbar', async () => {
  const map = twoBranches();
  record(map, 'a1').detail = 'Supporting note';
  mount(map);
  const blobs: Blob[] = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => {
    blobs.push(value as Blob);
    return `blob:${blobs.length}`;
  });
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const names: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    names.push(this.download);
  });
  for (const format of ['Markdown outline', 'Mermaid diagram', 'JSON data']) {
    exportMenu();
    menuItem(format).click();
  }
  expect(names).toEqual(['Root.md', 'Root.mmd', 'Root.json']);
  const outline = await blobs[0].text();
  // The heading carries the revision and the export time; the outline follows it.
  expect(outline).toMatch(/^# Root · Revision 0 · /);
  expect(outline).toContain('- Root\n  - A\n    - A1\n      > Supporting note\n  - B\n    - B1\n');
  expect(await blobs[1].text()).toContain('flowchart TD');
  expect(JSON.parse(await blobs[2].text())).toEqual(map);
  await vi.advanceTimersByTimeAsync(1000);
  expect(revoke).toHaveBeenCalledTimes(3);
});

it('offers to send manual changes when provided, respecting blockers and reporting failures', async () => {
  const send = vi.fn(async () => undefined);
  const { setExtra } = mount(twoBranches(), undefined, 1, undefined, {
    sendChanges: { blocker: 'Wait until the agent is idle.', send },
  });
  expect(button('Send changes').disabled).toBe(true);
  expect(button('Send changes').title).toBe('Wait until the agent is idle.');
  setExtra({ sendChanges: { send } });
  button('Send changes').click();
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  send.mockRejectedValueOnce(new Error('Agent unavailable'));
  button('Send changes').click();
  await vi.advanceTimersByTimeAsync(0);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Agent unavailable');
  setExtra({});
  expect(
    [...container.querySelectorAll('button')].map((item) => item.textContent?.trim()),
  ).not.toContain('Send changes');
});

it('keeps focus on Send changes while the map keeps changing', () => {
  const send = vi.fn(async () => undefined);
  const { state, setState, setExtra } = mount(twoBranches(), undefined, 1, undefined, {
    sendChanges: { send },
  });
  button('Send changes').focus();
  // The host rebuilds the delivery on every edit; the button must survive that.
  setExtra({ sendChanges: { send } });
  setState('document', { ...unwrap(state.document), revision: state.document.revision + 1 });
  vi.runAllTicks();
  expect(document.activeElement).toBe(button('Send changes'));
});

it('describes the map with one hint instead of a key legend on every idea', () => {
  mount(twoBranches());
  const section = expectDefined(container.querySelector('section'));
  const hint = document.getElementById(section.getAttribute('aria-describedby') ?? '');
  expect(hint?.textContent).toBe('Right-click for actions · F2 rename · Ctrl+wheel zoom');
  expect(idea('a').getAttribute('aria-label')).not.toContain('Enter or Tab');
});
