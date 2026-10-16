import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KANBAN_MARKDOWN,
  addCard,
  buildKanbanTaskPrompt,
  findCard,
  linkCardToBranch,
  moveCard,
  moveColumn,
  parseKanban,
  removeColumn,
  serializeKanban,
  updateCard,
} from './kanban';

const SAMPLE = `# Launch plan

Ship the new sync engine.

## Backlog

- [ ] Write migration
  Move old records to the new schema.

  Keep a backup.
- [ ] Docs

## In progress

Limit: 3 cards.

- [ ] Sync engine
  branch: \`task/sync-engine\`

## Done

- [x] Spike
`;

describe('parseKanban', () => {
  it('reads the title, preamble, columns, cards, descriptions and branches', () => {
    const board = parseKanban(SAMPLE);
    expect(board.title).toBe('Launch plan');
    expect(board.preamble).toBe('Ship the new sync engine.');
    expect(board.columns.map((c) => c.title)).toEqual(['Backlog', 'In progress', 'Done']);
    expect(board.columns[0].cards[0]).toEqual({
      title: 'Write migration',
      done: false,
      body: 'Move old records to the new schema.\n\nKeep a backup.',
      branches: [],
    });
    expect(board.columns[1].notes).toBe('Limit: 3 cards.');
    expect(board.columns[1].cards[0].branches).toEqual(['task/sync-engine']);
    expect(board.columns[1].cards[0].body).toBe('');
    expect(board.columns[2].cards[0].done).toBe(true);
  });

  it('round-trips its own output unchanged', () => {
    const once = serializeKanban(parseKanban(SAMPLE));
    expect(once).toBe(SAMPLE);
    expect(serializeKanban(parseKanban(once))).toBe(once);
  });

  it('accepts plain list items, other bullets and CRLF line endings', () => {
    const board = parseKanban('## Todo\r\n* one\r\n+ [X] two\r\n- three\r\n');
    expect(board.columns[0].cards.map((c) => [c.title, c.done])).toEqual([
      ['one', false],
      ['two', true],
      ['three', false],
    ]);
  });

  it('keeps fenced code in a description out of the board structure', () => {
    const board = parseKanban(
      '## Todo\n- [ ] Card\n  ```md\n  ## Not a column\n  - not a card\n  ```\n',
    );
    expect(board.columns).toHaveLength(1);
    expect(board.columns[0].cards).toHaveLength(1);
    expect(board.columns[0].cards[0].body).toBe('```md\n## Not a column\n- not a card\n```');
  });

  it('parses the default board', () => {
    const board = parseKanban(DEFAULT_KANBAN_MARKDOWN);
    expect(board.columns.map((c) => c.title)).toEqual(['Backlog', 'In progress', 'Review', 'Done']);
    expect(serializeKanban(board)).toBe(DEFAULT_KANBAN_MARKDOWN);
  });
});

describe('board operations', () => {
  it('adds a card, checked when the column is a Done column', () => {
    const board = addCard(addCard(parseKanban(SAMPLE), 0, 'New\ncard'), 2, 'Old');
    expect(board.columns[0].cards.at(-1)).toMatchObject({ title: 'New card', done: false });
    expect(board.columns[2].cards.at(-1)).toMatchObject({ title: 'Old', done: true });
  });

  it('moves cards within and across columns, checking them in Done', () => {
    const board = parseKanban(SAMPLE);
    const reordered = moveCard(board, { column: 0, card: 0 }, 0, 2);
    expect(reordered.columns[0].cards.map((c) => c.title)).toEqual(['Docs', 'Write migration']);
    const done = moveCard(board, { column: 0, card: 1 }, 2, 0);
    expect(done.columns[2].cards[0]).toMatchObject({ title: 'Docs', done: true });
    const reopened = moveCard(done, { column: 2, card: 0 }, 0);
    expect(reopened.columns[0].cards.at(-1)).toMatchObject({ title: 'Docs', done: false });
    // The input board is never changed.
    expect(board.columns[0].cards).toHaveLength(2);
  });

  it('moves and removes columns, keeping the removed column’s cards', () => {
    const board = parseKanban(SAMPLE);
    expect(moveColumn(board, 2, 0).columns.map((c) => c.title)).toEqual([
      'Done',
      'Backlog',
      'In progress',
    ]);
    const removed = removeColumn(board, 1);
    expect(removed.columns.map((c) => c.title)).toEqual(['Backlog', 'Done']);
    expect(removed.columns[0].cards.map((c) => c.title)).toContain('Sync engine');
  });

  it('updates a card’s title, description and state', () => {
    const board = updateCard(
      parseKanban(SAMPLE),
      { column: 0, card: 1 },
      {
        title: 'Write docs',
        body: 'Cover the CLI.',
        done: true,
      },
    );
    expect(board.columns[0].cards[1]).toMatchObject({
      title: 'Write docs',
      body: 'Cover the CLI.',
      done: true,
    });
  });

  it('finds a card again after the board changed', () => {
    const board = parseKanban(SAMPLE);
    expect(
      findCard(board, { title: 'Docs', column: 'Backlog', ref: { column: 0, card: 1 } }),
    ).toEqual({ column: 0, card: 1 });
    const moved = moveCard(board, { column: 0, card: 1 }, 2, 0);
    expect(
      findCard(moved, { title: 'Docs', column: 'Backlog', ref: { column: 0, card: 1 } }),
    ).toEqual({ column: 2, card: 0 });
    expect(findCard(moved, { title: 'Gone' })).toBeNull();
  });

  it('links a branch to a card and moves it to In progress', () => {
    const board = parseKanban(SAMPLE);
    const linked = linkCardToBranch(board, { column: 0, card: 0 }, 'task/write-migration');
    expect(linked.ref).toEqual({ column: 1, card: 0 });
    expect(linked.board.columns[1].cards[0]).toMatchObject({
      title: 'Write migration',
      branches: ['task/write-migration'],
    });
    expect(serializeKanban(linked.board)).toContain(
      '- [ ] Write migration\n  Move old records to the new schema.\n\n  Keep a backup.\n  branch: `task/write-migration`',
    );
    // A second task on the same branch is not recorded twice.
    const again = linkCardToBranch(linked.board, linked.ref, 'task/write-migration');
    expect(again.board.columns[1].cards[0].branches).toEqual(['task/write-migration']);
  });

  it('leaves a done card where it is when linking', () => {
    const board = parseKanban(SAMPLE);
    const linked = linkCardToBranch(board, { column: 2, card: 0 }, 'task/spike-2');
    expect(linked.ref).toEqual({ column: 2, card: 0 });
    expect(linked.board.columns[2].cards[0].branches).toEqual(['task/spike-2']);
  });

  it('builds a task prompt from the card', () => {
    const prompt = buildKanbanTaskPrompt(parseKanban(SAMPLE), { column: 0, card: 0 });
    expect(prompt).toContain('Write migration\n\nMove old records to the new schema.');
    expect(prompt).toContain('"Backlog" column');
  });
});
