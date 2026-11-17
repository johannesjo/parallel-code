import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('../../store/check-suite-state', () => ({
  getProjectChecks: () => [],
  getTaskChecks: () => [],
}));

import { setStore, store } from '../../store/core';
import { CardsSettings } from './CardsSettings';

let dispose: (() => void) | undefined;
beforeEach(() => {
  setStore('cardDefinitions', [
    {
      id: 'risks',
      name: 'Risks',
      description: '',
      source: { kind: 'agent' },
      slots: [{ id: 'risks', type: 'items', label: 'Risks' }],
      enabled: true,
    },
  ]);
  setStore('tasks', {
    t1: { id: 't1', cards: { risks: { values: { risks: { type: 'items', items: [] } }, at: 1 } } },
  } as never);
  dispose = render(() => <CardsSettings />, document.body);
});
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  setStore('tasks', {});
});

const dialogs = () => [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')];
/** The question, which opens over the editor. */
const question = () => dialogs().find((d) => d.textContent?.includes('Remove card?'));
const click = (name: string, within: ParentNode = document.body) => {
  const found = [...within.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name,
  );
  if (!found) throw new Error(`No button "${name}"`);
  found.click();
};
const askToRemove = () => {
  click('Edit Risks');
  click('Remove card');
};

describe('Removing a card', () => {
  it('is offered on the row, asking first and removing once confirmed', () => {
    click('Remove Risks');
    expect(dialogs()).toHaveLength(1);
    expect(question()?.textContent).toContain('Remove "Risks"?');
    expect(store.cardDefinitions).toHaveLength(1);
    click('Remove', question());
    expect(dialogs()).toHaveLength(0);
    expect(store.cardDefinitions).toEqual([]);
    expect(store.tasks.t1.cards).not.toHaveProperty('risks');
  });

  it('keeps the card when asked from the row and cancelled', () => {
    click('Remove Risks');
    click('Cancel', question());
    expect(dialogs()).toHaveLength(0);
    expect(store.cardDefinitions.map((card) => card.id)).toEqual(['risks']);
  });

  it('is not offered for the built-in card, which is only switched off', () => {
    setStore('cardDefinitions', 0, 'builtIn', 'confidence');
    expect(() => click('Remove Risks')).toThrow('No button "Remove Risks"');
  });

  it('asks first, naming the card and what goes with it', () => {
    askToRemove();
    expect(store.cardDefinitions).toHaveLength(1);
    expect(question()?.textContent).toContain(
      'Remove "Risks"? The values it shows on your tasks are deleted with it.',
    );
  });

  it('opens above the editor it is asked from', () => {
    askToRemove();
    const overlay = question()?.closest<HTMLElement>('.dialog-overlay');
    // The editor sits at 1200 (CardEditor.tsx); below that the question would be hidden behind it.
    expect(Number(overlay?.style.zIndex)).toBeGreaterThan(1200);
  });

  it('keeps the card, its values and the open editor on Cancel', () => {
    askToRemove();
    click('Cancel', question());
    expect(question()).toBeUndefined();
    expect(dialogs()).toHaveLength(1);
    expect(store.cardDefinitions.map((card) => card.id)).toEqual(['risks']);
    expect(store.tasks.t1.cards).toHaveProperty('risks');
  });

  it('removes the card and its values and closes the editor once confirmed', () => {
    askToRemove();
    click('Remove', question());
    expect(dialogs()).toHaveLength(0);
    expect(store.cardDefinitions).toEqual([]);
    expect(store.tasks.t1.cards).not.toHaveProperty('risks');
  });
});

describe('Hiding a card until it has values', () => {
  const box = () =>
    [...document.body.querySelectorAll('label')]
      .find((l) => l.textContent?.trim() === 'Hide until it has values')
      ?.querySelector('input');

  it('is off by default and saved once ticked', () => {
    click('Edit Risks');
    const input = box();
    if (!input) throw new Error('No "Hide until it has values" checkbox');
    expect(input.checked).toBe(false);
    input.click();
    click('Save');
    expect(store.cardDefinitions[0].hideEmpty).toBe(true);
  });

  it('is not offered for a card that fills only when run', () => {
    setStore('cardDefinitions', 0, 'source', {
      kind: 'check',
      checkId: 'lint',
      mode: 'json',
      trigger: 'manual',
    });
    click('Edit Risks');
    expect(box()).toBeUndefined();
  });
});

describe('Dragging a card', () => {
  const rows = () => [...document.body.querySelectorAll<HTMLElement>('.cards-row')];
  const fire = (row: HTMLElement, type: string) =>
    row.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  /** The row dims a moment after the drag starts, once the browser has its picture of it. */
  const startDrag = async (row: HTMLElement) => {
    fire(row, 'dragstart');
    expect(row.hasAttribute('data-dragging')).toBe(false);
    await new Promise((resolve) => setTimeout(resolve));
  };
  const marks = () => rows().map((row) => row.dataset.drop);
  const order = () => store.cardDefinitions.map((card) => card.id);
  beforeEach(() => {
    for (const id of ['notes', 'steps'])
      setStore('cardDefinitions', store.cardDefinitions.length, {
        id,
        name: id,
        description: '',
        source: { kind: 'agent' },
        slots: [{ id: 'only', type: 'line', label: 'Only' }],
        enabled: true,
      });
  });

  it('dims the dragged row and marks the edge it will land on, moving down', async () => {
    const [risks, notes, steps] = rows();
    await startDrag(risks);
    expect(rows().map((row) => row.hasAttribute('data-dragging'))).toEqual([true, false, false]);
    fire(steps, 'dragover');
    expect(marks()).toEqual([undefined, undefined, 'after']);
    fire(notes, 'dragover');
    expect(marks()).toEqual([undefined, 'after', undefined]);
    fire(notes, 'drop');
    expect(order()).toEqual(['notes', 'risks', 'steps']);
    expect(marks()).toEqual([undefined, undefined, undefined]);
    expect(rows().some((row) => row.hasAttribute('data-dragging'))).toBe(false);
  });

  it('marks the top edge of the row it will land above, moving up', async () => {
    const [risks, , steps] = rows();
    await startDrag(steps);
    fire(risks, 'dragover');
    expect(marks()).toEqual(['before', undefined, undefined]);
    fire(risks, 'drop');
    expect(order()).toEqual(['steps', 'risks', 'notes']);
  });

  it('keeps the mark while the pointer moves within the list and drops it on leaving', async () => {
    const [risks, notes] = rows();
    const list = document.body.querySelector('.cards-list');
    const leaveTo = (relatedTarget: Element | null) =>
      list?.dispatchEvent(new MouseEvent('dragleave', { bubbles: true, relatedTarget }));
    await startDrag(risks);
    fire(notes, 'dragover');
    leaveTo(notes.querySelector('.cards-row-name'));
    expect(marks()).toEqual([undefined, 'after', undefined]);
    leaveTo(document.body);
    expect(marks()).toEqual([undefined, undefined, undefined]);
    // Still in hand: coming back over a row marks it again.
    expect(risks.hasAttribute('data-dragging')).toBe(true);
    fire(notes, 'dragover');
    expect(marks()).toEqual([undefined, 'after', undefined]);
  });

  it('shows no mark over the dragged row, nor once the drag is given up', async () => {
    const [risks, notes] = rows();
    await startDrag(risks);
    fire(risks, 'dragover');
    expect(marks()).toEqual([undefined, undefined, undefined]);
    fire(notes, 'dragover');
    fire(risks, 'dragend');
    expect(marks()).toEqual([undefined, undefined, undefined]);
    expect(order()).toEqual(['risks', 'notes', 'steps']);
  });
});
