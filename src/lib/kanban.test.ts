import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KANBAN_MARKDOWN,
  addCard,
  addColumn,
  advanceCardForBranch,
  archiveCard,
  buildKanbanPlanPrompt,
  buildKanbanTaskPrompt,
  cardChecklist,
  cardSummary,
  findCard,
  linkCardToBranch,
  moveCard,
  moveColumn,
  openDependencies,
  parseKanban,
  removeColumn,
  serializeKanban,
  titlesFromInput,
  toggleChecklistItem,
  updateCard,
} from './kanban';

const SAMPLE = `# Launch plan

Ship the new sync engine.

## Backlog

- [ ] Write migration
  Move old records to the new schema.

  Keep a backup.
  - [ ] Old rows readable
  - [x] Backup written
  depends: Sync engine
- [ ] Docs

## In progress

Limit: 3 cards.

- [ ] Sync engine
  branch: \`task/sync-engine\`

## Review

## Done

- [x] Spike
`;

describe('parseKanban', () => {
  it('reads the title, preamble, columns, cards, descriptions, dependencies and branches', () => {
    const board = parseKanban(SAMPLE);
    expect(board.title).toBe('Launch plan');
    expect(board.preamble).toBe('Ship the new sync engine.');
    expect(board.columns.map((c) => c.title)).toEqual(['Backlog', 'In progress', 'Review', 'Done']);
    expect(board.columns[0].cards[0]).toEqual({
      title: 'Write migration',
      done: false,
      body: 'Move old records to the new schema.\n\nKeep a backup.\n- [ ] Old rows readable\n- [x] Backup written',
      branches: [],
      depends: ['Sync engine'],
    });
    expect(board.columns[1].notes).toBe('Limit: 3 cards.');
    expect(board.columns[1].cards[0].branches).toEqual(['task/sync-engine']);
    expect(board.columns[1].cards[0].body).toBe('');
    expect(board.columns[3].cards[0].done).toBe(true);
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
      '## Todo\n- [ ] Card\n  ```md\n  ## Not a column\n  - not a card\n  branch: no\n  ```\n',
    );
    expect(board.columns).toHaveLength(1);
    expect(board.columns[0].cards).toHaveLength(1);
    expect(board.columns[0].cards[0].branches).toEqual([]);
    expect(board.columns[0].cards[0].body).toBe(
      '```md\n## Not a column\n- not a card\nbranch: no\n```',
    );
  });

  it('keeps Obsidian Kanban front matter and settings', () => {
    const obsidian = `---

kanban-plugin: board

---

## Todo

- [ ] One

## Done

**Complete**
- [x] Two

%% kanban:settings
\`\`\`
{"kanban-plugin":"board"}
\`\`\`
%%`;
    const board = parseKanban(obsidian);
    expect(board.frontmatter).toBe('---\n\nkanban-plugin: board\n\n---');
    expect(board.columns.map((c) => c.cards.map((card) => card.title))).toEqual([['One'], ['Two']]);
    expect(board.columns[1].notes).toBe('**Complete**');
    expect(board.footer).toContain('%% kanban:settings');
    const out = serializeKanban(board);
    expect(out.startsWith('---\n\nkanban-plugin: board\n\n---\n\n## Todo')).toBe(true);
    expect(out.trimEnd().endsWith('%%')).toBe(true);
    expect(parseKanban(out)).toEqual(board);
  });

  it('parses the default board', () => {
    const board = parseKanban(DEFAULT_KANBAN_MARKDOWN);
    expect(board.columns.map((c) => c.title)).toEqual(['Backlog', 'In progress', 'Review', 'Done']);
    expect(serializeKanban(board)).toBe(DEFAULT_KANBAN_MARKDOWN);
  });
});

describe('checklists and dependencies', () => {
  it('reads and toggles checklist items', () => {
    const board = parseKanban(SAMPLE);
    const card = board.columns[0].cards[0];
    expect(cardChecklist(card).map((i) => [i.text, i.done])).toEqual([
      ['Old rows readable', false],
      ['Backup written', true],
    ]);
    expect(cardSummary(card)).toBe('Move old records to the new schema.\n\nKeep a backup.');
    const toggled = toggleChecklistItem(board, { column: 0, card: 0 }, cardChecklist(card)[0].line);
    expect(cardChecklist(toggled.columns[0].cards[0]).every((i) => i.done)).toBe(true);
    expect(serializeKanban(toggled)).toContain('  - [x] Old rows readable');
  });

  it('reports dependencies that are not done yet', () => {
    const board = parseKanban(SAMPLE);
    expect(openDependencies(board, { column: 0, card: 0 })).toEqual(['Sync engine']);
    const done = moveCard(board, { column: 1, card: 0 }, 3);
    expect(openDependencies(done, { column: 0, card: 0 })).toEqual([]);
  });

  it('ignores dependencies on cards that are not on the board', () => {
    const board = updateCard(parseKanban(SAMPLE), { column: 0, card: 1 }, { depends: ['Nope'] });
    expect(openDependencies(board, { column: 0, card: 1 })).toEqual([]);
  });
});

describe('board operations', () => {
  it('adds a card, checked when the column is a Done column', () => {
    const board = addCard(addCard(parseKanban(SAMPLE), 0, 'New\ncard'), 3, 'Old');
    expect(board.columns[0].cards.at(-1)).toMatchObject({ title: 'New card', done: false });
    expect(board.columns[3].cards.at(-1)).toMatchObject({ title: 'Old', done: true });
  });

  it('turns typed or pasted lists into card titles', () => {
    expect(titlesFromInput('- [ ] One\n\n* Two\n3. Three\nFour')).toEqual([
      'One',
      'Two',
      'Three',
      'Four',
    ]);
  });

  it('moves cards within and across columns, checking them in Done', () => {
    const board = parseKanban(SAMPLE);
    const reordered = moveCard(board, { column: 0, card: 0 }, 0, 2);
    expect(reordered.columns[0].cards.map((c) => c.title)).toEqual(['Docs', 'Write migration']);
    const done = moveCard(board, { column: 0, card: 1 }, 3, 0);
    expect(done.columns[3].cards[0]).toMatchObject({ title: 'Docs', done: true });
    const reopened = moveCard(done, { column: 3, card: 0 }, 0);
    expect(reopened.columns[0].cards.at(-1)).toMatchObject({ title: 'Docs', done: false });
    // The input board is never changed.
    expect(board.columns[0].cards).toHaveLength(2);
  });

  it('moves and removes columns, keeping the removed column’s cards', () => {
    const board = parseKanban(SAMPLE);
    expect(moveColumn(board, 3, 0).columns.map((c) => c.title)).toEqual([
      'Done',
      'Backlog',
      'In progress',
      'Review',
    ]);
    const removed = removeColumn(board, 1);
    expect(removed.columns.map((c) => c.title)).toEqual(['Backlog', 'Review', 'Done']);
    expect(removed.columns[0].cards.map((c) => c.title)).toContain('Sync engine');
  });

  it('archives cards into an Archive column that stays last', () => {
    const board = parseKanban(SAMPLE);
    const archived = archiveCard(board, { column: 0, card: 1 });
    expect(archived.columns.at(-1)).toMatchObject({ title: 'Archive' });
    expect(archived.columns.at(-1)?.cards[0].title).toBe('Docs');
    const withColumn = addColumn(archived, 'Blocked');
    expect(withColumn.columns.map((c) => c.title).slice(-2)).toEqual(['Blocked', 'Archive']);
    // A second archive reuses the column.
    const again = archiveCard(archived, { column: 0, card: 0 });
    expect(again.columns.filter((c) => c.title === 'Archive')).toHaveLength(1);
    expect(again.columns.at(-1)?.cards.map((c) => c.title)).toEqual(['Write migration', 'Docs']);
  });

  it('updates a card’s title, description, state and dependencies', () => {
    const board = updateCard(
      parseKanban(SAMPLE),
      { column: 0, card: 1 },
      { title: 'Write docs', body: 'Cover the CLI.', done: true, depends: ['A', 'A', ' B '] },
    );
    expect(board.columns[0].cards[1]).toMatchObject({
      title: 'Write docs',
      body: 'Cover the CLI.',
      done: true,
      depends: ['A', 'B'],
    });
  });

  it('finds a card again after the board changed', () => {
    const board = parseKanban(SAMPLE);
    const hint = { title: 'Docs', column: 'Backlog', ref: { column: 0, card: 1 } };
    expect(findCard(board, hint)).toEqual({ column: 0, card: 1 });
    const moved = moveCard(board, { column: 0, card: 1 }, 3, 0);
    expect(findCard(moved, hint)).toEqual({ column: 3, card: 0 });
    expect(findCard(moved, { title: 'Gone' })).toBeNull();
  });
});

describe('task lifecycle', () => {
  it('links a branch to a card and moves it to In progress', () => {
    const board = parseKanban(SAMPLE);
    const linked = linkCardToBranch(board, { column: 0, card: 1 }, 'task/docs');
    expect(linked.ref).toEqual({ column: 1, card: 0 });
    expect(linked.board.columns[1].cards[0]).toMatchObject({
      title: 'Docs',
      branches: ['task/docs'],
    });
    expect(serializeKanban(linked.board)).toContain('- [ ] Docs\n  branch: `task/docs`');
    // A second task on the same branch is not recorded twice.
    const again = linkCardToBranch(linked.board, linked.ref, 'task/docs');
    expect(again.board.columns[1].cards[0].branches).toEqual(['task/docs']);
  });

  it('leaves a done card, or one already past In progress, where it is', () => {
    const board = parseKanban(SAMPLE);
    const done = linkCardToBranch(board, { column: 3, card: 0 }, 'task/spike-2');
    expect(done.ref).toEqual({ column: 3, card: 0 });
    const inReview = moveCard(board, { column: 0, card: 1 }, 2);
    const linked = linkCardToBranch(inReview, { column: 2, card: 0 }, 'task/docs');
    expect(linked.ref).toEqual({ column: 2, card: 0 });
  });

  it('moves a card to Review and then to Done as its task progresses', () => {
    const board = parseKanban(SAMPLE);
    const review = advanceCardForBranch(board, 'task/sync-engine', 'review');
    expect(review?.columns[2].cards.map((c) => c.title)).toEqual(['Sync engine']);
    const done = advanceCardForBranch(review ?? board, 'task/sync-engine', 'done');
    expect(done?.columns[3].cards[0]).toMatchObject({ title: 'Sync engine', done: true });
  });

  it('never moves a card backwards or touches one that is done', () => {
    const board = parseKanban(SAMPLE);
    const review = advanceCardForBranch(board, 'task/sync-engine', 'review');
    expect(review && advanceCardForBranch(review, 'task/sync-engine', 'review')).toBeNull();
    const done = advanceCardForBranch(board, 'task/sync-engine', 'done');
    expect(done && advanceCardForBranch(done, 'task/sync-engine', 'review')).toBeNull();
    expect(advanceCardForBranch(board, 'task/unknown', 'done')).toBeNull();
  });

  it('checks a merged card off in place on a board without a Done column ahead', () => {
    const board = parseKanban('## Todo\n- [ ] A\n  branch: `b`\n');
    expect(advanceCardForBranch(board, 'b', 'review')).toBeNull();
    expect(advanceCardForBranch(board, 'b', 'done')?.columns[0].cards[0].done).toBe(true);
  });

  it('builds a task prompt from the card, with criteria and dependencies', () => {
    const prompt = buildKanbanTaskPrompt(parseKanban(SAMPLE), { column: 0, card: 0 });
    expect(prompt).toContain('Write migration\n\nMove old records to the new schema.');
    expect(prompt).toContain('acceptance criteria');
    expect(prompt).toContain('builds on: Sync engine');
    expect(prompt).toContain('"Backlog" column');
  });

  it('builds a planning prompt that explains the file format', () => {
    const prompt = buildKanbanPlanPrompt('Add offline mode');
    expect(prompt).toContain('Add offline mode');
    expect(prompt).toContain('KANBAN.md');
    expect(prompt).toContain('depends:');
    expect(buildKanbanPlanPrompt('')).toContain('<describe the goal>');
  });
});
