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
  addIssueCard,
  findCardByIssue,
  parseGitHubIssueUrl,
  cardFingerprint,
  removeCard,
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
      issue: '',
      before: '',
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

describe("round trips that keep the author's Markdown", () => {
  const roundTrip = (md: string) => serializeKanban(parseKanban(md));

  it('never lets a fence in a description swallow the rest of the board', () => {
    const md =
      '## Todo\n\n- [ ] A\n  ```ts\n  const x = 1;\n  branch: `task/a`\n\n## Done\n\n- [x] C\n';
    const board = parseKanban(md);
    expect(board.columns.map((c) => c.title)).toEqual(['Todo', 'Done']);
    expect(board.columns[1].cards[0].title).toBe('C');
    // The unclosed fence is closed on write, so the board stays intact.
    const again = parseKanban(serializeKanban(board));
    expect(again.columns.map((c) => c.cards.length)).toEqual([1, 1]);
  });

  it('treats inline code with triple backticks as text, not a fence', () => {
    const board = updateCard(
      parseKanban('## Todo\n\n- [ ] A\n  branch: `task/a`\n\n## Done\n'),
      { column: 0, card: 0 },
      {
        body: '```npm test``` must pass',
      },
    );
    const again = parseKanban(serializeKanban(board));
    expect(again.columns.map((c) => c.title)).toEqual(['Todo', 'Done']);
    expect(again.columns[0].cards[0].branches).toEqual(['task/a']);
  });

  it('keeps a longer fence holding a shorter one together', () => {
    const md = '## Todo\n\n````\n```\n- [ ] not a card\n````\n\n- [ ] A\n\n## Done\n';
    const board = parseKanban(md);
    expect(board.columns[0].cards.map((c) => c.title)).toEqual(['A']);
    expect(board.columns[0].notes).toContain('- [ ] not a card');
    expect(roundTrip(roundTrip(md))).toBe(roundTrip(md));
  });

  it('keeps commented-out cards commented out', () => {
    const md = '## Todo\n\n<!--\n- [ ] old card\n-->\n\n- [ ] Live\n';
    const board = parseKanban(md);
    expect(board.columns[0].cards.map((c) => c.title)).toEqual(['Live']);
    expect(roundTrip(md)).toContain('<!--\n- [ ] old card\n-->');
  });

  it('keeps notes between cards in place', () => {
    const md = '## Todo\n\n- [ ] A\n\n### Phase 2\n\n- [ ] B\n\nTrailing note.\n';
    const board = parseKanban(md);
    expect(board.columns[0].cards[1].before).toBe('### Phase 2');
    expect(board.columns[0].after).toBe('Trailing note.');
    expect(roundTrip(md)).toBe(md);
  });

  it('keeps lazy and one-space continuation lines with their card', () => {
    const board = parseKanban('## Todo\n\n- [ ] A\nmore about A\n and this\n- [ ] B\n');
    expect(board.columns[0].cards[0].body).toBe('more about A\nand this');
    expect(board.columns[0].cards.map((c) => c.title)).toEqual(['A', 'B']);
    expect(board.columns[0].notes).toBe('');
  });

  it('reads thematic breaks as notes, not cards', () => {
    const board = parseKanban('## Todo\n\n* * *\n\n- [ ] A\n');
    expect(board.columns[0].cards.map((c) => c.title)).toEqual(['A']);
    expect(board.columns[0].notes).toBe('* * *');
  });

  it('keeps a closing hash that is part of the title', () => {
    const board = parseKanban('# F#\n\n## C#\n\n## Done ##\n');
    expect(board.title).toBe('F#');
    expect(board.columns.map((c) => c.title)).toEqual(['C#', 'Done']);
  });

  it('keeps the BOM and CRLF line endings', () => {
    const md = '\ufeff# Board\r\n\r\n## Todo\r\n\r\n- [ ] A\r\n';
    const board = parseKanban(md);
    expect(board.title).toBe('Board');
    expect(roundTrip(md)).toBe(md);
  });

  it('adds no title to a board that has none, and keeps text above the title', () => {
    expect(roundTrip('## Todo\n\n- [ ] A\n')).toBe('## Todo\n\n- [ ] A\n');
    const md = 'Intro.\n\n# Board\n\n## Todo\n';
    expect(roundTrip(md)).toBe(md);
  });

  it('keeps cards without a title', () => {
    const md = '## Todo\n\n- [ ]\n';
    expect(parseKanban(md).columns[0].cards[0].title).toBe('');
    expect(roundTrip(md)).toBe(md);
  });

  it('keeps tabs inside fenced code in a tab-indented card', () => {
    const md = '## Todo\n\n- [ ] Make\n\t```make\n\tall:\n\t\techo hi\n\t```\n';
    const board = parseKanban(md);
    expect(board.columns[0].cards[0].body).toContain('\techo hi');
  });

  it('keeps an indented code block in a description', () => {
    const md = '## Todo\n\n- [ ] A\n      code line\n';
    expect(roundTrip(md)).toBe(md);
  });

  it('only reads the settings block when it starts a line outside a card', () => {
    const board = parseKanban('## Todo\n\n- [ ] A\n  %% kanban:settings\n\n## Done\n');
    expect(board.columns.map((c) => c.title)).toEqual(['Todo', 'Done']);
    expect(board.footer).toBe('');
  });

  it('does not take a leading horizontal rule for front matter', () => {
    const board = parseKanban('---\n\n## Todo\n\n- [ ] A\n\n---\n\n## Done\n');
    expect(board.frontmatter).toBe('');
    expect(board.columns.map((c) => c.title)).toEqual(['Todo', 'Done']);
  });

  it('leaves prose that looks like metadata alone', () => {
    const board = parseKanban(
      '## Todo\n\n- [ ] A\n  Branch: develop is frozen\n  Depends on: whether v2 ships\n  - nested\n    branch: `x`\n',
    );
    const card = board.columns[0].cards[0];
    expect(card.branches).toEqual([]);
    expect(card.depends).toEqual([]);
    expect(card.body).toContain('Branch: develop is frozen');
    expect(card.body).toContain('branch: `x`');
  });
});

describe('column names', () => {
  it('does not take "Not started" for In progress or "Not done" for Done', () => {
    const board = parseKanban(
      '## Not started\n\n- [ ] A\n\n## In progress\n\n## Not done\n\n## Done\n',
    );
    expect(linkCardToBranch(board, { column: 0, card: 0 }, 'task/a').ref).toEqual({
      column: 1,
      card: 0,
    });
    const added = addCard(board, 2, 'B');
    expect(added.columns[2].cards[0].done).toBe(false);
    const merged = advanceCardForBranch(
      linkCardToBranch(board, { column: 0, card: 0 }, 'task/a').board,
      'task/a',
      'done',
    );
    expect(merged?.columns[3].cards[0]).toMatchObject({ title: 'A', done: true });
  });

  it('keeps a done card checked when it is archived and when its column is removed', () => {
    const board = parseKanban('## Todo\n\n## Done\n\n- [x] A\n');
    expect(archiveCard(board, { column: 1, card: 0 }).columns.at(-1)?.cards[0].done).toBe(true);
    expect(removeColumn(board, 1).columns[0].cards[0].done).toBe(false);
  });
});

describe('GitHub issues', () => {
  const url = 'https://github.com/acme/app/issues/12';

  it('adds an issue as a card once, keeping the link in the file', () => {
    const board = addIssueCard(parseKanban(DEFAULT_KANBAN_MARKDOWN), {
      title: 'Crash on start',
      url,
    });
    expect(board.columns[0].cards[0]).toMatchObject({ title: 'Crash on start', issue: url });
    expect(serializeKanban(board)).toContain('- [ ] Crash on start\n  issue: ' + url);
    expect(addIssueCard(board, { title: 'Again', url: url + '#issuecomment-1' })).toBe(board);
    expect(findCardByIssue(board, 'https://github.com/ACME/app/issues/12')).toEqual({
      column: 0,
      card: 0,
    });
  });

  it('reads issue links and mentions the issue in the task prompt', () => {
    const board = parseKanban(`## Todo\n\n- [ ] Crash\n  issue: ${url}\n`);
    expect(board.columns[0].cards[0].issue).toBe(url);
    expect(buildKanbanTaskPrompt(board, { column: 0, card: 0 })).toContain('Fixes #12');
    expect(parseGitHubIssueUrl('https://github.com/acme/app/pull/7')).toEqual({
      repo: 'acme/app',
      number: 7,
      kind: 'pr',
    });
    expect(parseGitHubIssueUrl('https://evil.example/acme/app/issues/1')).toBeNull();
  });

  it('strips controls and invisible characters from card text in the prompt', () => {
    const board = parseKanban('## Todo\n\n- [ ] A\u202e\n  run \u001b[201~ this\u200b\n');
    const prompt = buildKanbanTaskPrompt(board, { column: 0, card: 0 });
    // eslint-disable-next-line no-control-regex
    expect(prompt).not.toMatch(/[\u001b\u202e\u200b]/);
    expect(prompt).toContain('run [201~ this');
  });
});

describe('fuzzing findings', () => {
  const roundTrip = (md: string) => serializeKanban(parseKanban(md));

  it('treats a <!-- mentioned mid-sentence as text', () => {
    const board = parseKanban(
      '## Backlog\n\nTip: write `<!--` to hide text.\n\n- [ ] A\n  Mention <!-- in body\n  branch: `task/a`\n\n## Done\n\n- [x] B\n',
    );
    expect(board.columns.map((c) => c.cards.map((card) => card.title))).toEqual([['A'], ['B']]);
    expect(board.columns[0].cards[0].branches).toEqual(['task/a']);
  });

  it('keeps cards that land after an unclosed fence or comment in notes', () => {
    const board = parseKanban(
      '## Backlog\n\n- [ ] Ship it\n\n## Done\n\n- [x] Old\n\n<!-- scratch notes\n',
    );
    const archived = parseKanban(serializeKanban(archiveCard(board, { column: 0, card: 0 })));
    expect(archived.columns.flatMap((c) => c.cards).length).toBe(2);
  });

  it('keeps the indentation of free text', () => {
    const md = '    ## Not a column\n\n## Real\n\n    - [ ] example in code\n\n- [ ] Card\n';
    const board = parseKanban(roundTrip(md));
    expect(board.columns.map((c) => c.title)).toEqual(['Real']);
    expect(board.columns[0].cards.map((c) => c.title)).toEqual(['Card']);
  });

  it('leaves a sub-heading in place when the card below it is removed or moved', () => {
    const board = parseKanban(
      '## Backlog\n\n- [ ] A\n\n### Frontend\n\n- [ ] B\n- [ ] C\n\n## Done\n',
    );
    const removed = serializeKanban(removeCard(board, { column: 0, card: 1 }));
    expect(removed).toContain('### Frontend\n\n- [ ] C');
    const moved = serializeKanban(moveCard(board, { column: 0, card: 1 }, 1));
    expect(moved).toContain('### Frontend\n\n- [ ] C');
    expect(moved).toContain('## Done\n\n- [x] B');
  });

  it('keeps every issue line of a card, in order', () => {
    const md =
      '## Todo\n\n- [ ] X\n  issue: https://github.com/o/r/issues/1\n  issue: https://github.com/o/r/issues/2\n';
    expect(roundTrip(md)).toBe(md);
    expect(parseKanban(md).columns[0].cards[0].issue).toBe('https://github.com/o/r/issues/1');
  });

  it('keeps columns without a title', () => {
    expect(roundTrip('##\n\n- [ ] A\n')).toBe('##\n\n- [ ] A\n');
  });

  it('finds the right one of two cards with the same title', () => {
    const board = parseKanban('## Todo\n\n- [ ] Fix\n  first\n- [ ] Other\n- [ ] Fix\n  second\n');
    const fingerprint = cardFingerprint(board.columns[0].cards[2]);
    const shifted = removeCard(board, { column: 0, card: 1 });
    expect(
      findCard(shifted, {
        title: 'Fix',
        column: 'Todo',
        ref: { column: 0, card: 2 },
        fingerprint,
      }),
    ).toEqual({
      column: 0,
      card: 1,
    });
    const inserted = addCard(board, 0, 'New', '', 0);
    expect(
      findCard(inserted, {
        title: 'Fix',
        column: 'Todo',
        ref: { column: 0, card: 2 },
        fingerprint,
      }),
    ).toEqual({
      column: 0,
      card: 3,
    });
  });

  it('rejects issue URLs with spaces', () => {
    expect(parseGitHubIssueUrl('https://github.com/o/r/issues/1#x y')).toBeNull();
  });
});
