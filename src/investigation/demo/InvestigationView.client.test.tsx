import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvestigationView } from './InvestigationView';
import { LAST_STORY_SEQUENCE } from '../fixture';

// The canvas is verified in Electron; this suite exercises real presentation state.
vi.mock('../InvestigationGraph', () => ({
  InvestigationGraph: (props: { reducedMotion: boolean; pulseWork: boolean }) => (
    <div data-testid="graph" data-reduced={props.reducedMotion} data-pulse={props.pulseWork}>
      Graph surface
    </div>
  ),
}));
let dispose: (() => void) | undefined;
let container: HTMLDivElement;
function button(text: string) {
  const result = [...container.querySelectorAll('button')].find((b) => b.textContent === text);
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
}
function slider() {
  return container.querySelector<HTMLInputElement>(
    '[aria-label="Replay position"]',
  ) as HTMLInputElement;
}
function selection() {
  return container.querySelector<HTMLSelectElement>(
    'select[aria-label="Selected record"]',
  ) as HTMLSelectElement;
}
function select(id: string) {
  selection().value = id;
  selection().dispatchEvent(new Event('change', { bubbles: true }));
}
function advance(count: number) {
  for (let i = 0; i < count; i++) button('Next demo update').click();
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
  dispose = render(() => <InvestigationView />, container);
});
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('investigation presentation', () => {
  it('keeps full details out of the default view and opens a navigable hierarchy on selection', () => {
    expect(container.querySelector('aside')).toBeNull();
    button('Inspect').click();
    expect(container.querySelector('aside h2')?.textContent).toBe('Why duplicate tasks?');
    container
      .querySelector('aside')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(container.querySelector('aside')).toBeNull();
    select('G1');
    expect(container.querySelector('aside h2')?.textContent).toBe('Eliminate duplicate tasks');
    expect(container.querySelector('aside')?.textContent).toContain('Acceptance criteria');
    container.querySelector<HTMLButtonElement>('[aria-label="Close node details"]')?.click();
    expect(container.querySelector('aside')).toBeNull();
    expect(document.activeElement).toBe(selection());
    advance(5);
    button('Return to live').click();
    select('W8');
    expect(container.querySelector('[aria-label="Note hierarchy"]')?.textContent).toContain(
      'Target the retry path',
    );
    expect(container.querySelector('aside h2')?.textContent).toBe('Add a retry guard');
  });
  it('reveals hypotheses only when reported and distinguishes current work from selection', () => {
    expect([...selection().options].map((o) => o.value)).toEqual(['G1', 'BUG']);
    expect(container.querySelector('[aria-label="Current agent work"]')?.textContent).toContain(
      'Why duplicate tasks?',
    );
    advance(1);
    expect([...selection().options].map((o) => o.value)).toEqual(['G1', 'BUG', 'H1']);
    expect(selection().value).toBe('BUG');
    expect(container.querySelector('[aria-label="Current agent work"]')?.textContent).toContain(
      'H1 · Network redelivery',
    );
    button('Hold view').click();
    advance(1);
    expect([...selection().options].map((o) => o.value)).toEqual(['G1', 'BUG', 'H1']);
    expect(container.querySelector('[aria-label="Current agent work"]')?.textContent).toContain(
      'H2 · Retry reapplication',
    );
    button('Return to live').click();
    advance(LAST_STORY_SEQUENCE - 2);
    expect(container.querySelector('[aria-label="Current agent work"]')?.textContent).toContain(
      'No active work reported',
    );
  });
  it('holds selection, inspector, and keyboard focus while demo updates keep arriving', () => {
    advance(5);
    select('H3');
    const h3 = selection();
    h3.focus();
    button('Run demo').click();
    vi.advanceTimersByTime(3200);
    expect(slider().value).toBe('5');
    expect(slider().max).toBe('6');
    expect(selection().value).toBe('H3');
    expect(document.activeElement).toBe(h3);
    expect(container.textContent).toContain('1 unseen updates');
    expect(container.textContent).toContain('E22 challenges T4');
    button('Return to live').click();
    expect(slider().value).toBe('6');
    expect(selection().value).toBe('H3');
  });
  it('keeps corrections replayable and selection when scrubbing before its creation', () => {
    advance(LAST_STORY_SEQUENCE);
    select('E22');
    slider().value = '4';
    slider().dispatchEvent(new Event('input', { bubbles: true }));
    expect(container.textContent).toContain('not yet recorded at S4');
    expect(selection().value).toBe('E22');
    button('Return to live').click();
    expect(container.textContent).toContain('Controls were mixed');
    expect(container.textContent).toContain(
      'Controls were mixed → challenges → Repeat the retry path',
    );
  });
  it('retains collapsed branches and updates through a burst and deterministic replay', () => {
    advance(LAST_STORY_SEQUENCE);
    select('H2');
    button('Collapse branch').click();
    expect([...selection().options].some((o) => o.value === 'E21')).toBe(false);
    button('Burst of 10').click();
    expect(slider().max).toBe(String(LAST_STORY_SEQUENCE + 10));
    expect(slider().value).toBe(String(LAST_STORY_SEQUENCE));
    button('Return to live').click();
    button('Reopen branch').click();
    expect([...selection().options].some((o) => o.value === 'E21')).toBe(true);
    expect(container.textContent).toContain('Load-test annotation 10');
    button('Replay').click();
    vi.advanceTimersByTime(1600 * (LAST_STORY_SEQUENCE + 11));
    expect(slider().value).toBe(String(LAST_STORY_SEQUENCE + 10));
    expect(container.textContent).toContain('Load-test annotation 10');
  });
  it('cleans up both demo and replay timers on unmount', () => {
    button('Run demo').click();
    expect(vi.getTimerCount()).toBe(2);
    dispose?.();
    dispose = undefined;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps replay and held branch transitions enabled without pulsing historical work', () => {
    const graph = container.querySelector('[data-testid="graph"]') as HTMLElement;
    advance(5);
    button('Replay').click();
    expect(graph.dataset.reduced).toBe('false');
    expect(graph.dataset.pulse).toBe('false');
    vi.advanceTimersByTime(1600);
    expect(slider().value).toBe('1');
    expect(graph.dataset.reduced).toBe('false');
    button('Return to live').click();
    expect(graph.dataset.pulse).toBe('true');
    select('H2');
    button('Collapse branch').click();
    expect(graph.dataset.reduced).toBe('false');
    const reduce = [...container.querySelectorAll('label')]
      .find((label) => label.textContent?.includes('Reduce motion'))
      ?.querySelector('input');
    reduce?.click();
    expect(graph.dataset.reduced).toBe('true');
  });
});
