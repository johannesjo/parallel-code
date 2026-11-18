import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confidenceCard, type CardDefinition } from '../../lib/cards';

const { mockRequest } = vi.hoisted(() => ({ mockRequest: vi.fn() }));
vi.mock('../../lib/model-request', () => ({ startModelRequest: mockRequest }));
vi.mock('../../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('../../store/check-suite-state', () => ({
  getProjectChecks: () => [],
  getTaskChecks: () => [],
}));

import { setStore, store } from '../../store/core';
import { CardsSettings } from './CardsSettings';

const RISKS: CardDefinition = {
  id: 'risks',
  name: 'Risks',
  description: 'risks in the change',
  source: {
    kind: 'model',
    model: 'default',
    prompt: 'List risks.',
    inputs: ['diff'],
    trigger: 'after-turn',
  },
  slots: [
    { id: 'risks', type: 'items', label: 'Risks' },
    { id: 'old', type: 'line', label: 'Old note' },
  ],
  enabled: true,
};

let dispose: (() => void) | undefined;
beforeEach(() => {
  mockRequest.mockReset();
  setStore('showCards', true);
  setStore('projects', [
    { id: 'p1', name: 'One', path: '/one' },
    { id: 'p2', name: 'Two', path: '/two' },
  ] as never);
  setStore('cardDefinitions', [structuredClone(RISKS)]);
  setStore('tasks', {
    t1: {
      id: 't1',
      cards: {
        risks: {
          values: { risks: { type: 'items', items: [] }, old: { type: 'line', text: 'x' } },
          at: 1,
        },
      },
    },
  } as never);
  dispose = render(() => <CardsSettings />, document.body);
});
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  setStore('tasks', {});
});

const button = (name: string) => {
  const found = [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name,
  );
  if (!found) throw new Error(`No button "${name}"`);
  return found;
};
/** The editor's Add card, which the list's button of the same name comes before. */
const addInEditor = () => {
  const dialogs = document.body.querySelectorAll('[role="dialog"]');
  const found = [...(dialogs[dialogs.length - 1]?.querySelectorAll('button') ?? [])].find(
    (b) => b.textContent?.trim() === 'Add card',
  );
  if (!found) throw new Error('No Add card button in the editor');
  found.click();
};
/** A gallery tile, found by the card name it leads with. */
const tile = (name: string) => {
  const found = [...document.body.querySelectorAll('.card-tile')].find(
    (b) => b.querySelector('b')?.textContent === name,
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error(`No tile "${name}"`);
  return found;
};
const field = (label: string) => {
  const found = [...document.body.querySelectorAll('label')].find((l) =>
    l.textContent?.trim().startsWith(label),
  );
  const input = found?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
  if (!input) throw new Error(`No field "${label}"`);
  return input;
};
/** A checkbox of the editor's bar group; the Settings list behind it can hold the same labels. */
const barField = (label: string) => {
  const group = document.body.querySelector('[aria-label="In the bar below the title"]');
  const found = [...(group?.querySelectorAll('label') ?? [])].find(
    (l) => l.textContent?.trim() === label,
  );
  const input = found?.querySelector('input');
  if (!input) throw new Error(`No bar option "${label}"`);
  return input;
};
function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('Add card', () => {
  it('adds a gallery preset through the editor', () => {
    button('Add card').click();
    tile('Decisions').click();
    expect((field('Name') as HTMLInputElement).value).toBe('Decisions');
    // Nothing is saved yet, so there is nothing to remove.
    expect(() => button('Remove card')).toThrow('No button "Remove card"');
    addInEditor();
    const added = store.cardDefinitions.find((card) => card.id === 'decisions');
    expect(added).toMatchObject({ enabled: true, slots: [{ type: 'items', addUp: true }] });
  });

  it('opens the gallery and the editor above Settings', () => {
    const settingsLayer = 1100;
    button('Add card').click();
    const layer = () => {
      const overlays = document.body.querySelectorAll<HTMLElement>('.dialog-overlay');
      return Number(overlays[overlays.length - 1].style.zIndex);
    };
    expect(layer()).toBeGreaterThan(settingsLayer);
    tile('Decisions').click();
    expect(layer()).toBeGreaterThan(settingsLayer);
  });

  it('keeps the editor open on a stray click on the backdrop', () => {
    button('Add card').click();
    tile('Decisions').click();
    const overlays = document.body.querySelectorAll('.dialog-overlay');
    const overlay = overlays[overlays.length - 1];
    for (const event of ['mousedown', 'mouseup', 'click'])
      overlay.dispatchEvent(new MouseEvent(event, { bubbles: true }));
    expect((field('Name') as HTMLInputElement).value).toBe('Decisions');
  });

  it('drafts a card from a description, then adds it', async () => {
    mockRequest.mockReturnValue({
      result: Promise.resolve(
        '{"name":"Next step","source":{"kind":"model","prompt":"Say the next step."},"slots":[{"id":"next","type":"line","label":"Next"}]}',
      ),
      cancel: vi.fn(),
    });
    button('Add card').click();
    type(field('Describe your own'), 'what should happen next');
    button('Draft card').click();
    await vi.waitFor(() => expect((field('Name') as HTMLInputElement).value).toBe('Next step'));
    addInEditor();
    expect(store.cardDefinitions.at(-1)).toMatchObject({
      id: 'next-step',
      description: 'what should happen next',
      slots: [{ id: 'next', label: 'Next' }],
    });
  });
  it('opens no editor when the gallery closed while the draft was running', async () => {
    let reply: (text: string) => void = () => {};
    mockRequest.mockReturnValue({
      result: new Promise<string>((resolve) => (reply = resolve)),
      cancel: vi.fn(),
    });
    button('Add card').click();
    type(field('Describe your own'), 'what should happen next');
    button('Draft card').click();
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(document.body.textContent).not.toContain('Describe your own');
    reply(
      '{"name":"Next step","source":{"kind":"model","prompt":"x"},"slots":[{"id":"next","type":"line","label":"Next"}]}',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.body.querySelector('#card-editor-title')).toBeNull();
  });

  it('offers nothing to add once 40 cards exist', () => {
    const many = Array.from({ length: 39 }, (_, i) => ({ ...structuredClone(RISKS), id: `c${i}` }));
    setStore('cardDefinitions', [structuredClone(RISKS), ...many]);
    button('Add card').click();
    expect(document.body.textContent).toContain('40 cards at most');
    tile('Decisions').click();
    // No editor opened; the list's own Add card button is still there.
    expect(document.body.querySelector('#card-editor-title')).toBeNull();
    expect(button('Draft card').disabled).toBe(true);
  });
});

describe('the card list', () => {
  it("shows a model card's prompt on one line and the whole of it on request", () => {
    setStore('cardDefinitions', 0, 'source', { prompt: 'List risks.\nOne per line.' } as never);
    const line = document.body.querySelector<HTMLButtonElement>('.cards-prompt');
    if (!line) throw new Error('No prompt line');
    expect(document.body.querySelector('pre')).toBeNull();
    line.click();
    expect(line.getAttribute('aria-expanded')).toBe('true');
    expect(document.body.querySelector('pre')?.textContent).toBe('List risks.\nOne per line.');
    line.click();
    expect(document.body.querySelector('pre')).toBeNull();
  });
});

describe('the bar below the title', () => {
  it('takes the card summary and single values as pins, counted together on the pins button', () => {
    button('no pins').click();
    (field('Card summary') as HTMLInputElement).click();
    expect(store.cardDefinitions[0].mini).toBe(true);
    expect(button('1 pinned').getAttribute('aria-expanded')).toBe('true');
    (field('Old note') as HTMLInputElement).click();
    expect(store.cardDefinitions[0].pinned).toEqual(['old']);
    expect(button('2 pinned').getAttribute('aria-expanded')).toBe('true');
    (field('Card summary') as HTMLInputElement).click();
    expect(store.cardDefinitions[0]).not.toHaveProperty('mini');
    expect(button('1 pinned').getAttribute('aria-expanded')).toBe('true');
  });
});

describe('Edit card', () => {
  it('previews the card as the task shows it, following the draft', () => {
    button('Edit').click();
    const preview = () => document.body.querySelector('[aria-label="Preview"]');
    expect(preview()?.querySelector('.card-name')?.textContent).toBe('Risks');
    expect(preview()?.textContent).toContain('Timeout is not configurable');
    expect(preview()?.querySelector('[aria-label="Bar below title"]')).toBeNull();
    type(field('Name'), 'Risks found');
    (barField('Risks') as HTMLInputElement).click();
    expect(preview()?.querySelector('.card-name')?.textContent).toBe('Risks found');
    // The sample has two risks and no score past its threshold.
    expect(preview()?.querySelector('[aria-label="Bar below title"]')?.textContent).toBe(
      'Risks 2 items',
    );
    expect(store.cardDefinitions[0].name).toBe('Risks');
  });

  it('frames the preview as the cards pane of a task', () => {
    button('Edit').click();
    const pane = document.body.querySelector('[aria-label="Preview"] .cards-pane');
    if (!pane) throw new Error('No pane in the preview');
    expect(pane.querySelector('.task-pane-heading')?.textContent).toBe('Cards');
    // Once, open, as a task's pane shows every card.
    const rows = [...pane.querySelectorAll('.card')];
    expect(rows.map((row) => row.querySelector('.card-name')?.textContent)).toEqual(['Risks']);
    // The age a task would show for a card filled a minute ago.
    expect(rows[0].querySelector('.card-meta-state')?.textContent).toBe('1m');
    // Filled after each turn: no button of its own on a task, so none here.
    expect(pane.querySelector('.card-check')).toBeNull();
  });

  it('draws the button a task shows under a card filled on demand', () => {
    setStore('cardDefinitions', 0, 'source', {
      kind: 'model',
      model: 'default',
      prompt: 'List risks.',
      inputs: ['diff'],
      trigger: 'manual',
    });
    button('Edit').click();
    const run = document.body.querySelector('[aria-label="Preview"] .card-check button');
    expect(run?.textContent).toBe('Refresh');
    expect(run?.closest('fieldset[disabled]')).not.toBeNull();
  });

  it('draws the command and Run button a task shows under a check card', () => {
    setStore('cardDefinitions', 0, 'source', {
      kind: 'check',
      checkId: 'lint',
      mode: 'exit-code',
      trigger: 'manual',
    });
    button('Edit').click();
    const row = document.body.querySelector('[aria-label="Preview"] .card-check');
    // No project in this test has the check, so it is named by its id.
    expect(row?.querySelector('code')?.textContent).toBe('lint');
    expect(row?.querySelector('button')?.textContent).toBe('Run again');
  });

  it('leads with the preview, under its own heading, ahead of the form', () => {
    // A text slot shows a Copy button, the one control a card's sample can carry.
    setStore('cardDefinitions', 0, 'slots', 1, 'type', 'text');
    button('Edit').click();
    const preview = document.body.querySelector('[aria-label="Preview"]');
    if (!preview) throw new Error('No preview');
    expect(preview.querySelector('h3')?.textContent).toBe('Preview');
    // First in the dialog: read first beside the form, and on top when a narrow window stacks them.
    const follows = preview.compareDocumentPosition(field('Name')) & 4; // DOCUMENT_POSITION_FOLLOWING
    expect(follows).toBe(4);
    // Ahead of the form, its sample buttons (Copy) would be the first Tab stops, so they are switched off...
    const buttons = [...preview.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toContain('Copy');
    expect(buttons.filter((b) => !b.closest('fieldset[disabled]'))).toEqual([]);
    // ...while the sample itself stays readable to a screen reader, which `inert` would hide.
    expect(preview.querySelector('[inert]')).toBeNull();
  });

  it('saves when a check card runs by itself', () => {
    setStore('cardDefinitions', 0, 'source', {
      kind: 'check',
      checkId: 'lint',
      mode: 'exit-code',
      trigger: 'manual',
    });
    button('Edit').click();
    const runs = [...document.body.querySelectorAll('label')]
      .find((l) => l.textContent?.startsWith('Runs'))
      ?.querySelector('select');
    if (!runs) throw new Error('No Runs select');
    runs.value = 'finish';
    runs.dispatchEvent(new Event('change', { bubbles: true }));
    button('Save').click();
    expect(store.cardDefinitions[0].source).toMatchObject({ kind: 'check', trigger: 'finish' });
  });

  it('shows a JSON check the object to write, keyed by slot id', () => {
    setStore('cardDefinitions', 0, 'source', { kind: 'check', checkId: 'lint', mode: 'json' });
    button('Edit').click();
    const example = document.body.querySelector('pre[aria-label="Example output"]');
    expect(JSON.parse(example?.textContent ?? '')).toMatchObject({
      risks: [{ text: 'Timeout is not configurable' }, { text: 'Old helper left unused' }],
      old: 'Retries now back off before the third attempt.',
    });
  });

  it('adds, retypes and removes slots, then saves the layout', () => {
    button('Edit').click();
    button('Add slot').click();
    const types = document.body.querySelectorAll<HTMLSelectElement>(
      'select[aria-label="Slot type"]',
    );
    types[2].value = 'score';
    types[2].dispatchEvent(new Event('change', { bubbles: true }));
    button('Remove Old note').click();
    button('Save').click();
    expect(store.cardDefinitions[0].slots).toEqual([
      { id: 'risks', type: 'items', label: 'Risks' },
      { id: 'line', type: 'score', label: 'New slot' },
    ]);
  });

  it('forgets a threshold when its slot changes type and back', () => {
    button('Edit').click();
    const retype = (to: string) => {
      const select = document.body.querySelectorAll<HTMLSelectElement>(
        'select[aria-label="Slot type"]',
      )[1];
      select.value = to;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    };
    retype('score');
    type(field('Warn below'), '70');
    retype('line');
    retype('score');
    expect((field('Warn below') as HTMLInputElement).value).toBe('');
  });

  it('saves a rename and a project switched off', () => {
    button('Edit').click();
    type(field('Name'), 'Risks found');
    (field('Two') as HTMLInputElement).click();
    button('Save').click();
    expect(store.cardDefinitions[0]).toMatchObject({
      name: 'Risks found',
      projects: { p2: false },
    });
  });

  it('saves what the card shows in the bar below the title, and switching it off again', () => {
    button('Edit').click();
    const bar = () => document.body.querySelector('[aria-label="Preview"] .pin[data-mini]');
    expect(bar()).toBeNull();
    (barField('Card summary') as HTMLInputElement).click();
    // The preview draws the bar at once: the card's name, then its collapsed summary.
    expect(bar()?.textContent).toBe(
      'Risks 2 items · Retries now back off before the third attempt.',
    );
    (barField('Old note') as HTMLInputElement).click();
    button('Save').click();
    expect(store.cardDefinitions[0]).toMatchObject({ mini: true, pinned: ['old'] });
    button('Edit').click();
    (barField('Card summary') as HTMLInputElement).click();
    (barField('Old note') as HTMLInputElement).click();
    button('Save').click();
    expect(store.cardDefinitions[0]).not.toHaveProperty('mini');
    expect(store.cardDefinitions[0]).not.toHaveProperty('pinned');
  });

  it('keeps the bar options out of the slot rows, in one group', () => {
    button('Edit').click();
    const slots = document.body.querySelector('ul[aria-label="Slots"]');
    // A list slot keeps its own add-up box and every slot its show box; what goes in the bar is
    // no longer set per slot.
    const slotBoxes = [...(slots?.querySelectorAll('label:has(input[type="checkbox"])') ?? [])];
    expect(slotBoxes.map((l) => l.textContent?.trim())).toEqual([
      'Add up across turns',
      'Show in card',
      'Show in card',
    ]);
    const group = document.body.querySelector('[aria-label="In the bar below the title"]');
    expect([...(group?.querySelectorAll('label') ?? [])].map((l) => l.textContent?.trim())).toEqual(
      ['Card summary', 'Risks', 'Old note'],
    );
  });

  it('names slot types in plain words and still saves their ids', () => {
    button('Edit').click();
    const select = document.body.querySelector<HTMLSelectElement>('select[aria-label="Slot type"]');
    expect(
      [...(select?.options ?? [])].map((option) => [option.value, option.textContent]),
    ).toEqual([
      ['line', 'Line'],
      ['text', 'Text block'],
      ['score', 'Score 0–100'],
      ['scores', 'Score list'],
      ['stat', 'Number'],
      ['items', 'List'],
      ['checklist', 'Checklist'],
      ['status', 'Status list'],
    ]);
  });

  it('clears the check a model card ran first when None is picked', () => {
    setStore('cardDefinitions', 0, 'source', { checkId: 'lint' } as never);
    button('Edit').click();
    const check = [...document.body.querySelectorAll('label')]
      .find((l) => l.textContent?.startsWith('Check'))
      ?.querySelector('select');
    if (!check) throw new Error('No check select');
    check.value = '';
    check.dispatchEvent(new Event('change', { bubbles: true }));
    button('Save').click();
    expect(store.cardDefinitions[0].source).not.toHaveProperty('checkId');
  });

  it('switches one project back on, keeping the other override', () => {
    setStore('cardDefinitions', 0, 'projects', { p1: false, p2: false });
    button('Edit').click();
    (field('One') as HTMLInputElement).click();
    button('Save').click();
    expect(store.cardDefinitions[0].projects).toEqual({ p2: false });
  });

  it('previews a layout drafted from the edited description, and clears values of lost slots on save', async () => {
    mockRequest.mockReturnValue({
      result: Promise.resolve(
        '{"name":"Ignored","source":{"kind":"model","prompt":"List risks."},"slots":[{"id":"risks","type":"items","label":"Risks"}]}',
      ),
      cancel: vi.fn(),
    });
    setStore('cardDefinitions', 0, 'source', { checkId: 'lint' } as never);
    button('Edit').click();
    type(field('Description'), 'only the risks');
    button('Draft new layout').click();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('clears stored values of Old note'),
    );
    button('Use new layout').click();
    button('Save').click();
    expect(store.cardDefinitions[0].slots.map((slot) => slot.id)).toEqual(['risks']);
    expect(store.cardDefinitions[0].name).toBe('Risks');
    expect(store.cardDefinitions[0].source).not.toHaveProperty('checkId');
    expect(store.tasks.t1.cards?.risks?.values).toEqual({ risks: { type: 'items', items: [] } });
  });
});

describe('Edit Confidence', () => {
  beforeEach(() => {
    setStore('cardDefinitions', [confidenceCard(true), structuredClone(RISKS)]);
  });

  it('edits its slots like a user card, without a source, description or Remove', () => {
    button('Edit Confidence').click();
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).not.toContain('Description');
    expect(dialog?.textContent).not.toContain('Remove card');
    expect(() => button('Remove Confidence')).toThrow();
    const labels = [...(dialog?.querySelectorAll('input[aria-label="Slot label"]') ?? [])];
    expect(labels.map((input) => (input as HTMLInputElement).value)).toEqual([
      'Scores',
      'Findings',
      'What changed',
      'Read first',
      'Asked',
    ]);
  });

  it('warns that removing the findings keeps every task from looking ready to merge', () => {
    button('Edit Confidence').click();
    const note = () => document.body.querySelector('[role="dialog"] [role="note"]');
    expect(note()).toBeNull();
    button('Remove Findings').click();
    expect(note()?.textContent).toContain('no task shows as ready to merge');
    button('Save').click();
    const saved = store.cardDefinitions.find((card) => card.builtIn === 'confidence');
    expect(saved?.slots.map((slot) => slot.id)).toEqual(['scores', 'changes', 'keyLine', 'asked']);
    expect(saved?.source).toEqual({ kind: 'agent' });
  });

  it('asks for room instead of dropping a slot when the layout is full', () => {
    const full = Array.from({ length: 8 }, (_, i) => ({
      id: `line-${i}`,
      type: 'line' as const,
      label: `Line ${i}`,
    }));
    setStore('cardDefinitions', [confidenceCard(true, full), structuredClone(RISKS)]);
    button('Edit Confidence').click();
    button('Add them back').click();
    const labels = document.body.querySelectorAll('input[aria-label="Slot label"]');
    expect(labels).toHaveLength(8);
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(
      'Remove a slot first',
    );
  });

  it('adds the score list and findings back from the note', () => {
    button('Edit Confidence').click();
    button('Remove Findings').click();
    button('Add them back').click();
    expect(document.body.querySelector('[role="dialog"] [role="note"]')).toBeNull();
    button('Save').click();
    const saved = store.cardDefinitions.find((card) => card.builtIn === 'confidence');
    expect(saved?.slots.map((slot) => slot.id)).toEqual([
      'scores',
      'findings',
      'changes',
      'keyLine',
      'asked',
    ]);
  });
});
