import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InvestigationGraph } from './InvestigationGraph';
import { makeFixture } from './fixture';

let container: HTMLDivElement;
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  dispose?.();
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(
  reduced = false,
  follow = false,
  orientation: 'vertical' | 'horizontal' = 'vertical',
) {
  const history = makeFixture();
  const [snapshot, setSnapshot] = createSignal(history.snapshots[4]);
  const [selected, setSelected] = createSignal('');
  const [locateRequest, setLocateRequest] = createSignal(0);
  const hold = vi.fn(),
    select = vi.fn();
  dispose = render(
    () => (
      <InvestigationGraph
        snapshot={snapshot()}
        selected={selected()}
        locateId="H2"
        collapsed={new Set()}
        follow={follow}
        reducedMotion={reduced}
        orientation={orientation}
        pulseWork={true}
        locateRequest={locateRequest()}
        onHold={hold}
        onSelect={select}
      />
    ),
    container,
  );
  return { setSnapshot, setSelected, setLocateRequest, history, hold, select };
}
function node(id: string) {
  return container.querySelector<HTMLButtonElement>(`[data-record-id="${id}"]`);
}

it('renders evidence as a theme-colored outline document icon', () => {
  mount();
  const icon = container.querySelector('[data-kind="observation"] .investigation-node-symbol svg');
  expect(icon).not.toBeNull();
  expect(icon?.namespaceURI).toBe('http://www.w3.org/2000/svg');
  expect(icon?.getAttribute('fill')).toBe('none');
  expect(icon?.getAttribute('stroke')).toBe('currentColor');
  expect(icon?.querySelector('path')?.namespaceURI).toBe('http://www.w3.org/2000/svg');
  expect(icon?.querySelector('path')?.getAttribute('fill')).toBe('none');
  expect(icon?.querySelector('path')?.getAttribute('stroke')).toBe('currentColor');
});

it('leaves modified arrow keys to app navigation without panning the canvas', () => {
  const { hold } = mount();
  const surface = container.querySelector('.investigation-svg');
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
    const event = new KeyboardEvent('keydown', {
      key,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    surface?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
  expect(hold).not.toHaveBeenCalled();
});

it.each(['vertical', 'horizontal'] as const)(
  'routes peer connections and their labels outside intervening cards in %s layout',
  (orientation) => {
    const { setSnapshot, setSelected, history } = mount(true, false, orientation);
    setSnapshot({
      ...history.snapshots[4],
      relations: [
        { id: 'ac', source: 'H1', target: 'H3', kind: 'supports', rationale: 'Related' },
        { id: 'ca', source: 'H3', target: 'H1', kind: 'challenges', rationale: 'Counterpoint' },
      ],
    });
    setSelected('H1');
    const links = [...container.querySelectorAll('.investigation-evidence-link')];
    expect(links).toHaveLength(2);
    const horizontal = orientation === 'horizontal';
    const axis = horizontal ? 'x' : 'y';
    const size = horizontal ? 'width' : 'height';
    const rowEnd = Math.max(
      ...['H1', 'H2', 'H3'].map((id) => {
        const card = node(id)?.closest('foreignObject');
        return Number(card?.getAttribute(axis)) + Number(card?.getAttribute(size));
      }),
    );
    for (const link of links) {
      expect(link.getAttribute('opacity')).toBe('1');
      expect(link.querySelector('path')?.getAttribute('d')).toContain(' Q');
      expect(Number(link.querySelector('text')?.getAttribute(axis))).toBeGreaterThan(rowEnd);
    }
    expect(links[0].querySelector('path')?.getAttribute('d')).not.toBe(
      links[1].querySelector('path')?.getAttribute('d'),
    );
    setSelected('');
    const faint = [...container.querySelectorAll('.investigation-evidence-link')];
    expect(faint).toHaveLength(2);
    expect(faint.every((link) => link.getAttribute('data-active') === 'false')).toBe(true);
  },
);

it('keeps active and selected ancestry bright while dimming other branches', () => {
  const { setSnapshot, setSelected, history } = mount(true);
  setSnapshot(history.snapshots[7]);
  setSelected('H1');
  const muted = (id: string) =>
    node(id)?.closest('.investigation-node-shell')?.getAttribute('data-muted');
  for (const id of ['G1', 'BUG', 'H1', 'H2', 'H22', 'T5']) expect(muted(id)).toBe('false');
  for (const id of ['H3', 'H21', 'T4']) expect(muted(id)).toBe('true');
  setSelected('H3');
  expect(muted('H1')).toBe('true');
  expect(muted('H3')).toBe('false');
  expect(muted('T5')).toBe('false');
  setSnapshot({ ...history.snapshots[7], activeId: undefined });
  expect(muted('T5')).toBe('true');
  setSelected('');
  expect(muted('T5')).toBe('false');
});

it('fades rejected notes and unlikely hypotheses with their branches until selected', () => {
  const { setSnapshot, setSelected, history } = mount(true);
  const muted = (id: string) =>
    node(id)?.closest('.investigation-node-shell')?.getAttribute('data-muted');
  const base = { ...history.snapshots[4], activeId: undefined };
  const withRecord = (id: string, changes: Partial<(typeof base.records)[number]>) => ({
    ...base,
    records: base.records.map((r) => (r.id === id ? { ...r, ...changes } : r)),
  });
  setSnapshot(base);
  for (const id of ['H1', 'H2', 'T4', 'E21']) expect(muted(id)).toBe('false');
  setSnapshot(withRecord('H2', { confidence: 0.2 }));
  for (const id of ['H2', 'T4', 'E21']) expect(muted(id)).toBe('true');
  expect(muted('H1')).toBe('false');
  setSelected('H2');
  expect(muted('H2')).toBe('false');
  expect(muted('T4')).toBe('true');
  setSelected('');
  setSnapshot(withRecord('H2', { confidence: 0.4 }));
  expect(muted('H2')).toBe('false');
  setSnapshot(withRecord('H1', { status: 'rejected' }));
  expect(muted('H1')).toBe('true');
  expect(muted('H2')).toBe('false');
});

it('hides internal IDs on cards and shows only reported hypothesis confidence, including zero', () => {
  const { setSnapshot, history } = mount(true);
  expect(node('H1')?.querySelector('.investigation-node-kind')?.textContent?.trim()).toBe(
    'Hypothesis',
  );
  expect(node('H1')?.textContent).not.toContain('H1');
  expect(node('H1')?.querySelector('.investigation-node-confidence')).toBeNull();
  for (const confidence of [0.73, 0]) {
    setSnapshot({
      ...history.snapshots[4],
      records: history.snapshots[4].records.map((r) => (r.id === 'H1' ? { ...r, confidence } : r)),
    });
    expect(node('H1')?.textContent).toContain(`${Math.round(confidence * 100)}% confidence`);
  }
});

it('updates card bounds and row spacing after content grows and shrinks', () => {
  const callbacks: ResizeObserverCallback[] = [];
  const disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    vi.fn(function (callback: ResizeObserverCallback) {
      callbacks.push(callback);
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect };
    }),
  );
  mount(true);
  const original = node('H2');
  const shell = original?.closest('.investigation-node-shell');
  const box = original?.closest('foreignObject');
  if (!shell || !box) throw new Error('Missing card');
  const beforeY = Number(box.getAttribute('y'));
  const measure = (height: number) =>
    callbacks[0](
      [{ target: shell, contentRect: { height } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
  measure(120);
  expect(Number(box.getAttribute('height'))).toBe(160);
  measure(68);
  expect(Number(box.getAttribute('height'))).toBe(108);
  expect(Number(box.getAttribute('y'))).toBe(beforeY);
  expect(node('H2')).toBe(original);
  dispose?.();
  dispose = undefined;
  expect(disconnect).toHaveBeenCalledTimes(2);
});

it('preserves buttons and focus across revisions, and animates new discoveries', () => {
  const { history, setSnapshot, select } = mount();
  vi.advanceTimersByTime(400);
  const original = node('H2');
  original?.focus();
  expect(node('H21')).toBeNull();
  setSnapshot(history.snapshots[5]);
  const entry = node('H21')?.closest('foreignObject');
  expect(Number((entry as SVGForeignObjectElement).style.opacity)).toBe(0);
  vi.advanceTimersByTime(100);
  const opacity = Number((entry as SVGForeignObjectElement).style.opacity);
  expect(opacity).toBeGreaterThan(0);
  expect(opacity).toBeLessThan(1);
  vi.advanceTimersByTime(300);
  expect(node('H2')).toBe(original);
  expect(document.activeElement).toBe(original);
  // happy-dom does not expose HTMLElement.click inside foreignObject; Chromium does.
  original?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(select).toHaveBeenCalledWith('H2');
  expect(Number((entry as SVGForeignObjectElement).style.opacity)).toBe(1);
});

it('pans with an ordinary wheel and changes scale only for explicit zoom', () => {
  const { hold } = mount(true);
  const svg = container.querySelector('svg');
  const camera = () => svg?.querySelector('g')?.getAttribute('transform');
  const initial = camera();
  svg?.dispatchEvent(new WheelEvent('wheel', { deltaY: 80, bubbles: true, cancelable: true }));
  expect(camera()).not.toBe(initial);
  expect(camera()).toContain('scale(1)');
  expect(hold).toHaveBeenCalled();
  container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click();
  expect(camera()).toContain('scale(1.2)');
});

it('reduced motion presents discoveries immediately and cleanup cancels animation', () => {
  const { history, setSnapshot } = mount(true);
  setSnapshot(history.snapshots[5]);
  expect((node('H21')?.closest('foreignObject') as SVGForeignObjectElement).style.opacity).toBe(
    '1',
  );
  dispose?.();
  dispose = undefined;
  expect(vi.getTimerCount()).toBe(0);
});

it('uses compact cards in a narrow pane and restores normal cards when expanded', () => {
  const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  let resize = () => {};
  vi.stubGlobal(
    'ResizeObserver',
    vi.fn(function (callback: ResizeObserverCallback) {
      resize = () => callback([], {} as ResizeObserver);
      return { observe: vi.fn(), disconnect: vi.fn(), unobserve: vi.fn() };
    }),
  );
  mount(true);
  const original = node('H2');
  const cardWidth = () =>
    (original?.closest('.investigation-node-shell') as HTMLElement).style.width;
  expect(cardWidth()).toBe('112px');
  width.mockReturnValue(1000);
  resize();
  expect(cardWidth()).toBe('196px');
  expect(node('H2')).toBe(original);
  width.mockReturnValue(400);
  resize();
  expect(cardWidth()).toBe('112px');
});

it('keeps the three compact branches in view without unnecessarily centering current work', () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  const { setSnapshot, history } = mount(true, true);
  setSnapshot(history.snapshots[3]);
  expect(container.querySelector('.investigation-svg > g')?.getAttribute('transform')).toBe(
    'translate(200,72) scale(1)',
  );
});

it('finishes a requested camera move when a held reasoning layout updates', () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  const { setLocateRequest, setSnapshot, history } = mount();
  vi.advanceTimersByTime(400);
  const camera = () => container.querySelector('svg g')?.getAttribute('transform');
  setLocateRequest(1);
  vi.advanceTimersByTime(100);
  const midway = camera();
  setSnapshot(history.snapshots[5]);
  vi.advanceTimersByTime(300);
  expect(camera()).not.toBe(midway);
});
