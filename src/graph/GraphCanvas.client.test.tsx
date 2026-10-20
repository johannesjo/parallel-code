import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GraphCanvas } from './GraphCanvas';
import type { MapOrientation } from './layout';
import type { MindMapDocument } from './model';

let container: HTMLDivElement;
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  dispose?.();
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function map(): MindMapDocument {
  return {
    version: 1,
    revision: 0,
    records: [
      { id: 'root', title: 'Root', detail: '' },
      {
        id: 'a',
        parent: 'root',
        title: 'A',
        detail: '',
        sources: [{ label: 'Spec', url: 'https://example.org/spec' }],
      },
      { id: 'b', parent: 'root', title: 'B', detail: '' },
    ],
    relations: [{ id: 'ab', source: 'a', target: 'b', kind: 'supports' }],
  };
}
function mount(
  initialOrientation: MapOrientation = 'vertical',
  showOwnership = false,
  dimUnconnected = false,
  reducedMotion = true,
) {
  const [snapshot, setSnapshot] = createSignal(map());
  const [selected, setSelected] = createSignal('root');
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  const [orientation, setOrientation] = createSignal(initialOrientation);
  dispose = render(
    () => (
      <GraphCanvas
        snapshot={snapshot()}
        selected={selected()}
        locateId={selected()}
        collapsed={collapsed()}
        follow={false}
        reducedMotion={reducedMotion}
        pulseWork={false}
        orientation={orientation()}
        showOwnership={showOwnership}
        dimUnselected={!dimUnconnected}
        dimUnconnected={dimUnconnected}
        locateRequest={0}
        onHold={() => {}}
        onSelect={setSelected}
        onToggle={(id) =>
          setCollapsed((before) => {
            const next = new Set(before);
            if (!next.delete(id)) next.add(id);
            return next;
          })
        }
      />
    ),
    container,
  );
  vi.advanceTimersByTime(50);
  return { setSnapshot, setSelected, setCollapsed, setOrientation };
}
const node = (id: string) => container.querySelector<HTMLElement>(`[data-record-id="${id}"]`);
const link = () => container.querySelector('.investigation-evidence-link');
const camera = () => container.querySelector('svg > g')?.getAttribute('transform') ?? '';

it('anchors horizontal maps at the left edge and vertical maps at the top centre', () => {
  mount('horizontal');
  expect(camera()).toBe('translate(134,300) scale(1)');
  dispose?.();
  mount('vertical');
  expect(camera()).toBe('translate(400,72) scale(1)');
});

it('refits the camera when the controlled orientation changes', () => {
  const { setOrientation } = mount('vertical');
  const before = camera();
  setOrientation('horizontal');
  const fitted = camera();
  expect(fitted).not.toBe(before);
  expect(
    container.querySelector('.investigation-graph-wrap')?.getAttribute('data-orientation'),
  ).toBe('horizontal');
  container.querySelector<HTMLButtonElement>('[aria-label="Fit map"]')?.click();
  expect(camera()).toBe(fitted);
});

it('marks the selected note with aria-current rather than a pressed state', () => {
  const { setSelected } = mount();
  setSelected('a');
  expect(node('a')?.getAttribute('aria-current')).toBe('true');
  expect(node('a')?.hasAttribute('aria-pressed')).toBe(false);
  expect(node('b')?.hasAttribute('aria-current')).toBe(false);
});

it('shows only the selected note’s cross-links, otherwise all faintly with hover highlight', () => {
  const { setSelected } = mount();
  expect(link()).toBeNull();
  setSelected('a');
  expect(link()?.getAttribute('data-active')).toBe('true');
  setSelected('');
  expect(link()?.getAttribute('data-active')).toBe('false');
  node('b')?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
  expect(link()?.getAttribute('data-active')).toBe('true');
  node('b')?.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
  expect(link()?.getAttribute('data-active')).toBe('false');
});

it('dims every note but the hovered or selected one and its parent, children and links', () => {
  const { setSnapshot, setSelected } = mount('vertical', false, true);
  setSnapshot((before) => ({
    ...before,
    records: [...before.records, { id: 'c', parent: 'b', title: 'C', detail: '' }],
  }));
  const muted = (id: string) =>
    node(id)?.closest('.investigation-node-shell')?.getAttribute('data-muted');
  setSelected('a');
  expect(['root', 'a', 'b'].map(muted)).toEqual(['false', 'false', 'false']);
  expect(muted('c')).toBe('true');
  node('c')?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
  // Hover dims only after a pause, then hands over between notes without releasing.
  expect(muted('c')).toBe('true');
  vi.advanceTimersByTime(250);
  expect(['b', 'c'].map(muted)).toEqual(['false', 'false']);
  expect(['root', 'a'].map(muted)).toEqual(['true', 'true']);
  node('c')?.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
  node('root')?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
  expect(['root', 'a', 'b'].map(muted)).toEqual(['false', 'false', 'false']);
  expect(muted('c')).toBe('true');
  node('root')?.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
  expect(muted('c')).toBe('true');
  vi.advanceTimersByTime(200);
  expect(muted('c')).toBe('true');
  expect(muted('b')).toBe('false');
  setSelected('');
  expect(['root', 'a', 'b', 'c'].map(muted)).toEqual(['false', 'false', 'false', 'false']);
});

it('keeps fades on an idle graph unless motion is reduced', () => {
  mount('vertical', false, true, false);
  expect(container.querySelector('.investigation-graph-wrap')?.getAttribute('data-reduced')).toBe(
    'false',
  );
});

it('marks a note with sources by a corner link icon naming them', () => {
  mount();
  const mark = node('a')?.querySelector('.mindmap-sources-indicator');
  expect(mark?.getAttribute('title')).toBe('1 source: Spec');
  expect(mark?.querySelector('svg')).not.toBeNull();
  expect(node('b')?.querySelector('.mindmap-sources-indicator')).toBeNull();
});

it('marks agent arrivals briefly and counts those hidden under collapsed branches', () => {
  const { setSnapshot, setCollapsed } = mount();
  const fresh = (id: string) => node(id)?.closest('[data-fresh]')?.getAttribute('data-fresh');
  expect(fresh('a')).toBe('false');
  setSnapshot((before) => ({
    ...before,
    revision: 1,
    records: [
      ...before.records,
      { id: 'c', parent: 'root', title: 'C', detail: '' },
      { id: 'mine', parent: 'root', title: 'Mine', detail: '', userEdited: ['*'] },
    ],
  }));
  vi.advanceTimersByTime(50);
  expect(fresh('c')).toBe('true');
  expect(fresh('mine')).toBe('false');
  vi.advanceTimersByTime(3000);
  expect(fresh('c')).toBe('false');
  setCollapsed(new Set(['a']));
  setSnapshot((before) => ({
    ...before,
    revision: 2,
    records: [
      ...before.records,
      { id: 'a1', parent: 'a', title: 'A1', detail: '' },
      { id: 'a2', parent: 'a', title: 'A2', detail: '' },
    ],
  }));
  vi.advanceTimersByTime(3050);
  const expand = () => container.querySelector<HTMLButtonElement>('[aria-label^="Expand A"]');
  expect(expand()?.getAttribute('aria-label')).toBe('Expand A (2 new)');
  expect(container.querySelector('.mindmap-new-badge')?.textContent).toBe('2 new');
  expand()?.click();
  vi.advanceTimersByTime(50);
  expect(container.querySelector('.mindmap-new-badge')).toBeNull();
  expect(container.querySelector('[aria-label="Collapse A"]')).not.toBeNull();
});

it('shows ownership marks only when asked', () => {
  const { setSnapshot } = mount('vertical', false);
  setSnapshot((before) => ({
    ...before,
    records: before.records.map((r) => (r.id === 'a' ? { ...r, userEdited: ['kind'] } : r)),
  }));
  expect(node('a')?.querySelector('.mindmap-ownership')).toBeNull();
  dispose?.();
  mount('vertical', true);
  expect(node('a')?.querySelector('.mindmap-ownership')).toBeNull();
});

it('takes Escape only when it closes a note preview', () => {
  mount();
  const surface = container.querySelector<SVGSVGElement>('svg.investigation-graph');
  const escape = () => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    surface?.dispatchEvent(event);
    return event.defaultPrevented;
  };
  node('a')?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
  // Handled, so the same press does not also leave focus mode behind it.
  expect(escape()).toBe(true);
  expect(escape()).toBe(false);
});
