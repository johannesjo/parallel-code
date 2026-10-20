import { describe, expect, it } from 'vitest';
import { TOUR_FILE_MAX_CHARS } from '../../electron/shared/understanding-limits';
import {
  cardReference,
  notesReference,
  isTourFilePath,
  parseTourFile,
  serializeTour,
  tourFileName,
  type TourFile,
} from './tour-file';
import type { TourNode } from './tour-tree';
import type { TourCard } from './understanding-tour';

const slide: TourCard = {
  label: 'KEY DECISION',
  title: 'Each task gets its own working copy',
  body: '',
  points: ['Edits never touch your checkout', 'One branch per task, like `task/x`'],
  notes: 'Worktrees share one object store.\n\n# Not a heading\n\n```sh\n# a comment\n```',
  tone: 'important',
  questions: ['What about submodules?'],
  refs: [{ filePath: 'electron/ipc/git.ts', line: 3, endLine: 9 }, { filePath: 'README.md' }],
};
const flow: TourCard = {
  label: 'MAIN FLOW',
  title: 'Output | input flow',
  body: 'Batched before IPC.',
  tone: 'risk',
  form: 'flow',
  diagram: { kind: 'text', source: 'PTY -> ``` -> IPC\n  # indented' },
  refs: [],
};
const compared: TourCard = {
  label: 'TRADE-OFF',
  title: 'Batching beats streaming here',
  body: '',
  tone: 'neutral',
  form: 'comparison',
  comparison: [
    { label: 'Before', text: 'One message | per chunk' },
    { label: 'After', text: 'One per flush' },
  ],
  source: 'We keep the buffer before IPC.',
  whyItMatters: 'Fewer wake-ups.',
  refs: [],
};
const prose: TourCard = {
  label: 'GOTCHA',
  title: 'Flush on exit',
  body: '- a body list\n- stays body\n\n## a heading inside',
  tone: 'uncertainty',
  refs: [],
};

function tree(): TourNode[] {
  return [
    {
      id: 'c1',
      card: slide,
      children: [
        {
          id: 'c2',
          card: flow,
          question: 'Go deeper on this point: One branch per task',
          children: [{ id: 'c3', card: prose, question: 'What --> breaks?', children: [] }],
        },
      ],
    },
    { id: 'c4', card: compared, children: [] },
  ];
}

const file: TourFile = {
  subject: 'docs/worktrees.md',
  kind: 'document',
  source: 'docs/worktrees.md',
  omitted: ['Appendix, the long one'],
  roots: tree(),
};

/** Ids are handed out again on load; everything else must survive. */
function withoutIds(nodes: TourNode[]): unknown {
  return nodes.map(({ id: _id, children, ...rest }) => ({
    ...rest,
    children: withoutIds(children),
  }));
}

describe('tour file', () => {
  it('round-trips every card field, the nesting and the front matter', () => {
    const text = serializeTour(file, { forFile: true });
    const parsed = parseTourFile(text);
    expect(parsed).toMatchObject({
      subject: file.subject,
      kind: 'document',
      source: file.source,
      omitted: file.omitted,
    });
    expect(withoutIds(parsed.roots)).toEqual(withoutIds(file.roots));
    expect(serializeTour(parsed, { forFile: true })).toBe(text);
  });

  it('writes an outline of headings a person can read', () => {
    const text = serializeTour(file, { forFile: true });
    expect(text.startsWith('---\nparallel-code-tour: 1\nkind: document\n')).toBe(true);
    expect(text).toContain('\n# docs/worktrees.md\n\n## Each task gets its own working copy\n');
    expect(text).toContain('\n### Output | input flow\n');
    expect(text).toContain('\n#### Flush on exit\n');
    expect(text).toContain('**KEY DECISION**\n\n- Edits never touch your checkout\n');
    expect(text).toContain('<details><summary>Notes</summary>');
    expect(text).toContain('\\# Not a heading');
    expect(text).toContain('\\## a heading inside');
    expect(text).toContain('| Before | After |\n| --- | --- |\n| One message \\| per chunk |');
    // The comment that carries the metadata cannot be closed by a question.
    expect(text).not.toContain('What --> breaks');
  });

  it('copies without front matter and names the omitted sections in prose', () => {
    const text = serializeTour(file, { forFile: false });
    expect(text.startsWith('# Tour: docs/worktrees.md\n')).toBe(true);
    expect(text).not.toContain('parallel-code-tour');
    expect(text).not.toContain('tour-card');
    expect(text).not.toContain('<!-- points -->');
    expect(text.trimEnd().endsWith('_Not covered: Appendix, the long one_')).toBe(true);
  });

  it('reads a hand-written outline: headings alone are cards, skipped levels nest once', () => {
    const parsed = parseTourFile(
      [
        '---',
        'parallel-code-tour: 1',
        '---',
        '# Why we cache',
        '## Reads dominate',
        '- 90% of calls are reads',
        '  and they repeat',
        '#### Measured last week',
        'From the dashboard.',
        '## Writes stay simple',
      ].join('\n'),
    );
    expect(parsed.subject).toBe('Why we cache');
    expect(parsed.kind).toBe('agent');
    expect(parsed.roots.map((root) => root.card.title)).toEqual([
      'Reads dominate',
      'Writes stay simple',
    ]);
    expect(parsed.roots[0].card.points).toEqual(['90% of calls are reads and they repeat']);
    expect(parsed.roots[0].children[0].card).toMatchObject({
      title: 'Measured last week',
      body: 'From the dashboard.',
      tone: 'neutral',
    });
    expect(parsed.roots[1].card).toMatchObject({ label: '', body: '' });
  });

  it.each([
    ['# Plain notes\n\n## Card', 'not a saved tour'],
    ['---\nparallel-code-tour: 1\n---\n# Title only\n', 'no cards'],
    [`---\nparallel-code-tour: 1\n---\n${'x'.repeat(TOUR_FILE_MAX_CHARS)}`, 'too large'],
    [
      `---\nparallel-code-tour: 1\n---\n${Array.from({ length: 201 }, (_, i) => `## C${i}`).join('\n')}`,
      'too many cards',
    ],
  ])('rejects what is not a tour (%#)', (text, message) => {
    expect(() => parseTourFile(text)).toThrow(message);
  });

  it('keeps a card written without a title, and the cards under it', () => {
    const untitled: TourCard = {
      label: '',
      title: '',
      body: 'Only a body',
      tone: 'neutral',
      refs: [],
    };
    const child: TourCard = { ...untitled, title: 'C', body: 'cc' };
    const roots: TourNode[] = [
      { id: 'a', card: untitled, children: [{ id: 'c', card: child, children: [] }] },
      { id: 'b', card: { ...child, title: 'B', body: 'bb' }, children: [] },
    ];
    const tour: TourFile = { subject: '', kind: 'thinking', roots };
    expect(withoutIds(parseTourFile(serializeTour(tour, { forFile: true })).roots)).toEqual(
      withoutIds(roots),
    );
    // Its subject is its first card's title, so it stays empty for the list to name.
    expect(parseTourFile(serializeTour(tour, { forFile: true })).subject).toBe('');
    const alone: TourFile = { ...tour, roots: [{ id: 'a', card: untitled, children: [] }] };
    expect(parseTourFile(serializeTour(alone, { forFile: true })).roots[0].card.body).toBe(
      'Only a body',
    );
  });

  it('skips a heading with nothing in it', () => {
    const text = '---\nparallel-code-tour: 1\n---\n\n# T\n\n##\n\n## Kept\n\nBody\n';
    expect(parseTourFile(text).roots.map((root) => root.card.title)).toEqual(['Kept']);
  });

  it('keeps unknown or broken metadata from failing the file', () => {
    const parsed = parseTourFile(
      '---\nparallel-code-tour: 1\nkind: sideways\n---\n## Card\n<!-- tour-card {broken -->\nBody\n',
    );
    expect(parsed.kind).toBe('agent');
    expect(parsed.roots[0].card.body).toBe('<!-- tour-card {broken -->\nBody');
  });

  it('references one card for the agent with its place in the tour and the saved file', () => {
    const roots = tree();
    const trail = [roots[0], roots[0].children[0]];
    const reference = cardReference({
      subject: 'Worktrees',
      savedPath: 'worktrees.tour.md',
      trail,
    });
    expect(reference).toContain('tour: Worktrees');
    expect(reference).toContain(
      'Position: Each task gets its own working copy › Output | input flow',
    );
    expect(reference).toContain('Asked: Go deeper on this point: One branch per task');
    expect(reference).toContain('saved in worktrees.tour.md');
    expect(reference).toContain('### Output | input flow\n\n**⚠ MAIN FLOW**');
    expect(reference).not.toContain('tour-card');
    expect(cardReference({ subject: 'x', trail: [roots[1]] })).not.toContain('saved in');
    expect(cardReference({ subject: 'x', trail: [] })).toBe('');
  });

  it('hands the reader notes to the agent with the tour they came from', () => {
    const reference = notesReference({
      subject: 'Worktrees',
      savedPath: 'worktrees.tour.md',
      notes: '  Cleanup never follows symlinks.\n',
    });
    expect(reference).toBe(
      'Notes from the tour: Worktrees\nThe whole tour is saved in worktrees.tour.md.\n\nCleanup never follows symlinks.',
    );
    expect(notesReference({ subject: 'x', notes: 'n' })).not.toContain('saved in');
    expect(notesReference({ subject: 'x', notes: ' \n ' })).toBe('');
  });

  describe('round trips that must not change a card', () => {
    const roundTrip = (cards: TourCard[]) => {
      const roots = cards.map((card, index) => ({ id: `c${index}`, card, children: [] }));
      const text = serializeTour({ subject: 'S', kind: 'file', roots }, { forFile: true });
      return { text, cards: parseTourFile(text).roots.map((root) => root.card) };
    };
    const base = { label: 'LABEL', title: 'Title', tone: 'neutral' as const, refs: [] };

    it('keeps a fence left open, or a line of inline code, from swallowing later cards', () => {
      const open: TourCard = { ...base, body: 'Run:\n```sh\nnpm i' };
      const inline: TourCard = { ...base, title: 'Inline', body: '```npm i``` installs it' };
      const after: TourCard = { ...base, title: 'After', body: 'Still here.' };
      const { cards } = roundTrip([open, inline, after]);
      expect(cards.map((card) => card.title)).toEqual(['Title', 'Inline', 'After']);
      expect(cards[0].body).toBe('Run:\n```sh\nnpm i\n```');
      expect(cards[1].body).toBe(inline.body);
      expect(cards[2].body).toBe('Still here.');
    });

    it('leaves tables, text fences, lists and field-like lines in a prose body alone', () => {
      const body = [
        '| Option | Cost |',
        '| --- | --- |',
        '| A | low |',
        '| B | high |',
        '',
        '```text',
        'a -> b',
        '```',
        '',
        '- one',
        '- two',
        '',
        'Refs: `not/a/ref.ts`',
        '> Source: “not a quote”',
        '> **Why this matters:** not the field',
      ].join('\n');
      const { cards } = roundTrip([{ ...base, body }]);
      expect(cards[0]).toEqual({ ...base, body });
    });

    it('keeps a caption list apart from the points', () => {
      const card: TourCard = {
        ...base,
        body: 'Caption:\n\n- part of the caption',
        points: ['A point'],
      };
      const { text, cards } = roundTrip([card]);
      expect(text).toContain('<!-- points -->\n- A point');
      expect(cards[0]).toEqual(card);
    });

    it('keeps notes whole when they quote the closing tag in code', () => {
      const notes = 'Before\n\n```html\n</details>\n```\n\nAfter';
      const { cards } = roundTrip([{ ...base, body: '', points: ['p'], notes }]);
      expect(cards[0].notes).toBe(notes);
    });

    it('keeps a title ending in "#" and a body whose first line is bold', () => {
      const { cards } = roundTrip([
        { ...base, title: 'Use C #', label: '', body: '**Bold start**\n\nThen text.' },
        { ...base, title: 'Prefer C#', body: '' },
      ]);
      expect(cards[0]).toMatchObject({
        title: 'Use C #',
        label: '',
        body: '**Bold start**\n\nThen text.',
      });
      expect(cards[1].title).toBe('Prefer C#');
    });
  });

  it('keeps lines that look like its own markers as text', () => {
    const roots = [
      {
        id: 'a',
        card: {
          label: 'L',
          title: 'T',
          tone: 'neutral' as const,
          refs: [],
          body: 'intro\n<!-- points -->\nafter\n</details>',
          points: ['p'],
          notes: 'Notes\n<details><summary>Notes</summary>\ninner',
        },
        children: [],
      },
    ];
    const text = serializeTour({ subject: 'S', kind: 'agent', roots }, { forFile: true });
    const [card] = parseTourFile(text).roots.map((root) => root.card);
    expect(card).toEqual(roots[0].card);
  });

  it('reads and writes a very long crafted body without overflowing the stack', () => {
    const body = Array.from({ length: 260_000 }, () => 'x').join('\n');
    const text = `---\nparallel-code-tour: 1\n---\n## Card\n<!-- tour-card {"fields":["body"]} -->\n${body}\n`;
    const parsed = parseTourFile(text);
    expect(parsed.roots[0].card.body.length).toBeLessThanOrEqual(8000);
    const diagram = { kind: 'text' as const, source: '`'.repeat(200_000) };
    const roots = [{ id: 'a', card: { ...parsed.roots[0].card, diagram }, children: [] }];
    expect(() =>
      serializeTour({ subject: 'S', kind: 'agent', roots }, { forFile: true }),
    ).not.toThrow();
  });

  it('reads single-quoted and bare front matter values', () => {
    const parsed = parseTourFile(
      "---\nparallel-code-tour: 1\nkind: document\nsubject: 'It''s docs/cache.md'\nsource: docs/cache.md\n---\n## Card\n",
    );
    expect(parsed).toMatchObject({ subject: "It's docs/cache.md", source: 'docs/cache.md' });
  });

  it('reads a crafted file quickly and caps what it keeps', () => {
    const spaces = ' '.repeat(200_000);
    const started = performance.now();
    const parsed = parseTourFile(
      `---\nparallel-code-tour: 1\n---\n## A${spaces}title${spaces}#\n- ${'x'.repeat(5000)}\n`,
    );
    expect(performance.now() - started).toBeLessThan(1000);
    expect(parsed.roots[0].card.title.length).toBeLessThanOrEqual(300);
    expect(parsed.roots[0].card.points?.[0].length).toBeLessThanOrEqual(300);
  });

  it('names a file after the subject and recognises tour files', () => {
    expect(tourFileName('docs/Guided Understanding Plan.md')).toBe(
      'guided-understanding-plan.tour.md',
    );
    expect(tourFileName('Why we cache?')).toBe('why-we-cache.tour.md');
    expect(tourFileName('???')).toBe('tour.tour.md');
    expect(isTourFilePath('notes/Cache.TOUR.md')).toBe(true);
    expect(isTourFilePath('notes/cache.md')).toBe(false);
  });
});
