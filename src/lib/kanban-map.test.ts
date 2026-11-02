import { describe, expect, it } from 'vitest';
import { boardToMap, KANBAN_MAP_ROOT } from './kanban-map';
import { moveCard, parseKanban } from './kanban';

const SAMPLE = `# Launch plan

Ship the new sync engine.

## Backlog

- [ ] Write migration
  Move old records to the new schema.
  - [ ] Old rows readable
  - [x] Backup written
  depends: Sync engine
- [ ] Docs
  depends: Nothing by this name

## In progress

- [ ] Sync engine

## Done

- [x] Spike

## Archive

- [x] Old idea
`;

const titleOf = (result: ReturnType<typeof boardToMap>, id: string) =>
  result.map.records.find((r) => r.id === id)?.title;

describe('boardToMap', () => {
  it('nests columns, cards and checklist items under the board title, in board order', () => {
    const { map } = boardToMap(parseKanban(SAMPLE));
    const tree = map.records.map((r) => [
      r.title,
      r.parent && titleOfParent(map.records, r.parent),
    ]);
    expect(tree).toEqual([
      ['Launch plan', undefined],
      ['Backlog', 'Launch plan'],
      ['Write migration', 'Backlog'],
      ['Old rows readable', 'Write migration'],
      ['Backup written', 'Write migration'],
      ['Docs', 'Backlog'],
      ['In progress', 'Launch plan'],
      ['Sync engine', 'In progress'],
      ['Done', 'Launch plan'],
      ['Spike', 'Done'],
      ['Archive', 'Launch plan'],
      ['Old idea', 'Archive'],
    ]);
    expect(map.records[0]).toMatchObject({
      id: KANBAN_MAP_ROOT,
      detail: 'Ship the new sync engine.',
    });
    expect(map.records[2].detail).toBe('Move old records to the new schema.');
  });

  it('links a card to the cards it waits for and skips titles that are not on the board', () => {
    const result = boardToMap(parseKanban(SAMPLE));
    expect(result.map.relations).toHaveLength(1);
    const [link] = result.map.relations;
    expect([titleOf(result, link.source), titleOf(result, link.target), link.kind]).toEqual([
      'Write migration',
      'Sync engine',
      'waits for',
    ]);
  });

  it('draws a dependency named twice once', () => {
    const board = parseKanban('# P\n\n## A\n\n- [ ] B\n  depends: C\n  depends: c\n- [ ] C\n');
    expect(boardToMap(board).map.relations).toHaveLength(1);
  });

  it('maps card nodes back to their place on the board', () => {
    const result = boardToMap(parseKanban(SAMPLE));
    const refs = [...result.cards].map(([id, ref]) => [titleOf(result, id), ref]);
    expect(refs).toContainEqual(['Sync engine', { column: 1, card: 0 }]);
    expect(refs).toHaveLength(5);
  });

  it('fades done cards and checked items, and folds checklists and the archive', () => {
    const result = boardToMap(parseKanban(SAMPLE));
    const titles = (ids: ReadonlySet<string>) => [...ids].map((id) => titleOf(result, id));
    expect(titles(result.faded).sort()).toEqual(['Backup written', 'Old idea', 'Spike']);
    expect(titles(result.folded).sort()).toEqual(['Archive', 'Write migration']);
  });

  it('keeps node IDs when cards move, so the canvas animates the move', () => {
    const board = parseKanban(SAMPLE);
    const before = boardToMap(board);
    const after = boardToMap(moveCard(board, { column: 0, card: 1 }, 1, 0));
    expect(after.map.records.find((r) => r.title === 'Docs')?.parent).toBe(
      before.map.records.find((r) => r.title === 'In progress')?.id,
    );
    const idFor = (result: typeof before, title: string) =>
      result.map.records.find((r) => r.title === title)?.id;
    expect(idFor(after, 'Docs')).toBe(idFor(before, 'Docs'));
    expect(idFor(after, 'Write migration')).toBe(idFor(before, 'Write migration'));
  });

  it('gives cards with the same title distinct, valid IDs', () => {
    const { map } = boardToMap(parseKanban('# P\n\n## A\n\n- [ ] Same\n- [ ] Same\n'));
    const ids = map.records.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
  });

  it('leaves out the cards the board filters hide', () => {
    const result = boardToMap(parseKanban(SAMPLE), [[1], [], [], []]);
    const cardTitles = [...result.cards.keys()].map((id) => titleOf(result, id));
    expect(cardTitles).toEqual(['Docs']);
    expect(result.map.records.filter((r) => r.parent === KANBAN_MAP_ROOT)).toHaveLength(4);
    expect(result.map.relations).toEqual([]);
  });
});

describe('boardToMap by theme', () => {
  const THEMED = `# P

## Backlog

- [ ] Login form
  group: Auth
  related: Invoices
- [ ] Invoices
  group: Billing
  related: Login form
- [ ] Loose end

## Doing

- [ ] Session store
  group: auth
  depends: Login form
  related: Login form

## Archive

- [x] Old idea
  group: Auth
`;

  it('hangs cards under their theme, unthemed ones last, and leaves the archive out', () => {
    const { map } = boardToMap(parseKanban(THEMED), undefined, 'theme');
    const tree = map.records.map((r) => [
      r.title,
      r.parent && titleOfParent(map.records, r.parent),
    ]);
    expect(tree).toEqual([
      ['P', undefined],
      ['Auth', 'P'],
      ['Login form', 'Auth'],
      ['Billing', 'P'],
      ['Invoices', 'Billing'],
      ['Session store', 'Auth'],
      ['No theme', 'P'],
      ['Loose end', 'No theme'],
    ]);
  });

  it('draws related cards once, and not where they already wait for each other', () => {
    for (const grouping of ['column', 'theme'] as const) {
      const result = boardToMap(parseKanban(THEMED), undefined, grouping);
      const links = result.map.relations.map((l) => [
        titleOf(result, l.source),
        l.kind,
        titleOf(result, l.target),
      ]);
      expect(links).toEqual([
        ['Session store', 'waits for', 'Login form'],
        ['Login form', 'relates to', 'Invoices'],
      ]);
    }
  });

  it('keeps a card’s node ID when switching grouping', () => {
    const board = parseKanban(THEMED);
    const idOf = (grouping: 'column' | 'theme') =>
      boardToMap(board, undefined, grouping).map.records.find((r) => r.title === 'Invoices')?.id;
    expect(idOf('theme')).toBe(idOf('column'));
  });
});

function titleOfParent(records: { id: string; title: string }[], id: string) {
  return records.find((r) => r.id === id)?.title;
}
