import { describe, expect, it } from 'vitest';
import { mergeAppBoardEdits } from './kanban-board-merge.js';

const lines = (...rows: string[]) => `${rows.join('\n')}\n`;

const BASE = lines(
  '# Board',
  '',
  '## Todo',
  '',
  '- [ ] Card A',
  '  - [ ] criterion',
  '- [ ] Card B',
  '',
  '## Doing',
);

describe('mergeAppBoardEdits', () => {
  it('replays a checkbox tick and a branch link in place, below a card the task added', () => {
    const local = BASE.replace('- [ ] Card A\n', '- [x] Card A\n').replace(
      '  - [ ] criterion\n',
      '  - [ ] criterion\n  branch: `task/a`\n',
    );
    const merged = BASE.replace('- [ ] Card A', '- [ ] Card New\n- [ ] Card A');
    expect(mergeAppBoardEdits({ base: BASE, local, merged })).toBe(
      lines(
        '# Board',
        '',
        '## Todo',
        '',
        '- [ ] Card New',
        '- [x] Card A',
        '  - [ ] criterion',
        '  branch: `task/a`',
        '- [ ] Card B',
        '',
        '## Doing',
      ),
    );
  });

  it('keeps branches the task added next to the one the app linked', () => {
    const withBranch = (branch: string) =>
      BASE.replace('- [ ] Card B\n', `- [ ] Card B\n  branch: \`${branch}\`\n`);
    const merged = withBranch('task/b').replace(
      '  branch: `task/b`\n',
      '  branch: `task/b`\n  branch: `task/c`\n',
    );
    expect(mergeAppBoardEdits({ base: BASE, local: withBranch('task/b'), merged })).toContain(
      '- [ ] Card B\n  branch: `task/b`\n  branch: `task/c`\n',
    );
  });

  it("keeps the task's tick on a card the app only moved", () => {
    const local = lines(
      '# Board',
      '',
      '## Todo',
      '',
      '- [ ] Card B',
      '',
      '## Doing',
      '',
      '- [ ] Card A',
      '  - [ ] criterion',
    );
    const merged = BASE.replace('- [ ] Card A', '- [x] Card A');
    expect(mergeAppBoardEdits({ base: BASE, local, merged })).toBe(
      lines(
        '# Board',
        '',
        '## Todo',
        '',
        '- [ ] Card B',
        '',
        '## Doing',
        '',
        '- [x] Card A',
        '  - [ ] criterion',
      ),
    );
  });

  it('gives up when the task moved the card the app moved', () => {
    const base = BASE.replace('## Doing', '## Doing\n\n## Done');
    const local = base
      .replace('- [ ] Card A\n  - [ ] criterion\n', '')
      .replace('## Doing\n', '## Doing\n\n- [ ] Card A\n  - [ ] criterion\n');
    const merged = base
      .replace('- [ ] Card A\n  - [ ] criterion\n', '')
      .replace('## Done', '## Done\n\n- [ ] Card A\n  - [ ] criterion');
    expect(mergeAppBoardEdits({ base, local, merged })).toBeNull();
  });

  it('accepts the task moving the card to the column the app moved it to', () => {
    const moved = lines(
      '# Board',
      '',
      '## Todo',
      '',
      '- [ ] Card B',
      '',
      '## Doing',
      '',
      '- [ ] Card A',
      '  - [ ] criterion',
    );
    const merged = moved.replace('- [ ] criterion', '- [x] criterion');
    expect(mergeAppBoardEdits({ base: BASE, local: moved, merged })).toBe(merged);
  });

  it("keeps the merged board's CRLF line endings and byte-order mark", () => {
    const local = BASE.replace('- [ ] Card A\n', '- [x] Card A\n');
    const merged = `\uFEFF${BASE.replace('- [ ] Card B', '- [ ] Card B\n  From the task').replace(/\n/g, '\r\n')}`;
    expect(mergeAppBoardEdits({ base: BASE, local, merged })).toBe(
      merged.replace('- [ ] Card A', '- [x] Card A'),
    );
  });

  it('gives up when the local board has edits other than moves, ticks and branches', () => {
    const local = BASE.replace('## Doing\n', '## Doing\n\n- [ ] Card C\n');
    expect(mergeAppBoardEdits({ base: BASE, local, merged: BASE })).toBeNull();
  });

  it('gives up when the moved card is gone from the merged board', () => {
    const local = lines(
      '# Board',
      '',
      '## Todo',
      '',
      '- [ ] Card B',
      '',
      '## Doing',
      '',
      '- [ ] Card A',
      '  - [ ] criterion',
    );
    const merged = BASE.replace('Card A', 'Card A2');
    expect(mergeAppBoardEdits({ base: BASE, local, merged })).toBeNull();
  });

  it('gives up when the column the card moved to is gone from the merged board', () => {
    const local = lines(
      '# Board',
      '',
      '## Todo',
      '',
      '- [ ] Card B',
      '',
      '## Doing',
      '',
      '- [ ] Card A',
      '  - [ ] criterion',
    );
    const merged = BASE.replace('## Doing', '## In progress');
    expect(mergeAppBoardEdits({ base: BASE, local, merged })).toBeNull();
  });

  it('gives up when an edited card shares its title with another card', () => {
    const twin = BASE.replace('Card B', 'Card A');
    const local = twin.replace(
      '- [ ] Card A\n  - [ ] criterion',
      '- [x] Card A\n  - [ ] criterion',
    );
    expect(mergeAppBoardEdits({ base: twin, local, merged: twin })).toBeNull();
  });
});
