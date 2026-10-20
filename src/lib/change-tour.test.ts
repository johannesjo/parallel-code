import { describe, expect, it } from 'vitest';
import {
  CHANGE_VERIFY_LABEL,
  buildChangeTourPrompts,
  changeFollowUpContext,
  parseChangeTour,
  stopToCard,
} from './change-tour';
import { GIST_LABEL } from './understanding-tour';
import { parseUnifiedDiff } from './unified-diff-parser';
import { CHANGE_TOUR_PROMPT_LIMIT } from '../../electron/shared/change-tour-limits';

const diff = 'diff --git a/file.ts b/file.ts\n@@ -1 +1 @@\n-old\n+new\n';
const files = parseUnifiedDiff(diff);
const stop = {
  title: 'Behavior',
  explanation: 'Changes the returned value.',
  tone: 'neutral' as const,
  locations: [{ filePath: 'file.ts', line: 1 }],
};

describe('change tours', () => {
  it.each([
    ['Here is the tour:\n', '\nThis tour covers the supplied change.'],
    ['', '\nNote: tests were not executed.'],
    ['Here is the tour:\n```json\n', '\n```\nSee [the code](file.ts).'],
  ])('accepts a complete tour surrounded by commentary (%s)', (prefix, suffix) => {
    expect(parseChangeTour(prefix + JSON.stringify({ stops: [stop] }) + suffix, files)).toEqual([
      stop,
    ]);
  });

  it('ignores braces and escaped quotes inside JSON strings when extracting a tour', () => {
    const withCode = { ...stop, explanation: 'Handles { nested: ["quoted"] } and \\ escapes.' };
    expect(parseChangeTour(JSON.stringify({ stops: [withCode] }) + '\nDone.', files)).toEqual([
      withCode,
    ]);
  });

  it.each([
    JSON.stringify({ stops: [stop] }) + '\n' + JSON.stringify({ stops: [stop] }),
    JSON.stringify({ stops: [stop] }) + '\n{"stops":[',
    '{"stops":[' + JSON.stringify(stop) + ',]}\nDone.',
    '{"stops":[' + JSON.stringify(stop),
  ])(
    'rejects ambiguous, truncated, or malformed output without a raw JSON exception',
    (response) => {
      expect(() => parseChangeTour(response, files)).toThrow(/provider.*retry the tour/i);
    },
  );

  it('still validates code references after extracting wrapped JSON', () => {
    const invalid = { ...stop, locations: [{ filePath: 'invented.ts', line: 1 }] };
    expect(() =>
      parseChangeTour('Tour:\n' + JSON.stringify({ stops: [invalid] }) + '\nDone.', files),
    ).toThrow('outside this diff');
  });

  it('accepts valid structured stops, including fenced JSON', () => {
    expect(
      parseChangeTour('```json\n' + JSON.stringify({ stops: [stop] }) + '\n```', files),
    ).toEqual([stop]);
  });
  it('keeps label, tone and why-it-matters, and drops bad hints without failing', () => {
    const rich = { ...stop, label: 'entry point', tone: 'risk', whyItMatters: 'Callers see it.' };
    expect(parseChangeTour(JSON.stringify({ stops: [rich] }), files)).toEqual([
      { ...stop, label: 'ENTRY POINT', tone: 'risk', whyItMatters: 'Callers see it.' },
    ]);
    const sloppy = { ...stop, label: 'x'.repeat(200), tone: 'scary', whyItMatters: 3 };
    expect(parseChangeTour(JSON.stringify({ stops: [sloppy] }), files)).toEqual([stop]);
  });

  it('draws a stop as a card whose refs are its locations', () => {
    expect(stopToCard(stop, 2)).toEqual({
      label: 'STOP 3',
      title: 'Behavior',
      body: 'Changes the returned value.',
      tone: 'neutral',
      refs: [{ filePath: 'file.ts', line: 1 }],
    });
    expect(stopToCard({ ...stop, label: 'TESTS', whyItMatters: 'Why.' }, 0)).toMatchObject({
      label: 'TESTS',
      whyItMatters: 'Why.',
    });
    expect(
      stopToCard({ ...stop, questions: ['What if the value is absent?'] }, 0).questions,
    ).toEqual(['What if the value is absent?']);
  });

  it('drops bad questions and forwards valid ones from stops', () => {
    const rich = {
      ...stop,
      questions: [
        '',
        '  What happens for an empty input? ',
        'what happens for an empty input?',
        42,
        'x'.repeat(141),
        'Does this change callers?',
        'A third question?',
      ],
    };
    const [parsed] = parseChangeTour(JSON.stringify({ stops: [rich] }), files);
    expect(parsed?.questions).toEqual([
      'What happens for an empty input?',
      'Does this change callers?',
    ]);
    expect(
      parseChangeTour(JSON.stringify({ stops: [rich] }), files).map(stopToCard)[0]?.questions,
    ).toEqual(parsed?.questions);
    expect(parseChangeTour(JSON.stringify({ stops: [{ ...stop, questions: {} }] }), files)).toEqual(
      [stop],
    );
  });

  it("adds the reader's rework request to every prompt", () => {
    const [prompt] = buildChangeTourPrompts('Task', diff, 'Focus on error handling');
    expect(prompt).toContain('"Focus on error handling"');
    expect(buildChangeTourPrompts('Task', diff)[0]).not.toContain('The reader asked');
  });

  it('asks for useful, bounded questions on stops and whole-change cards', () => {
    const [prompt] = buildChangeTourPrompts('Task', diff);
    expect(prompt).toContain(`0-2 short, specific questions`);
    expect(prompt).toContain('at most 140 characters each');
    expect(prompt).toContain('each stop, gist and verify');
    expect(prompt).toContain('Omit it when nothing useful remains to ask');
  });

  it('requests a compact tour for simple changes without padding by file or review phase', () => {
    const [prompt] = buildChangeTourPrompts('Task', diff);
    expect(prompt).toContain('For simple changes, use 1-2 cards total, usually a single stop');
    expect(prompt).toContain('Omit gist and verify for simple changes');
    expect(prompt).toContain('Group related changes across files, including their tests');
    expect(prompt).not.toContain('Aim for 4-6');
  });

  describe('gist and verify cards', () => {
    const gist = { title: 'The file returns new', explanation: 'It returned old.' };
    const verify = {
      title: 'Check callers expect new',
      explanation: 'Callers compare the value.',
      locations: [{ filePath: 'file.ts', line: 1 }],
    };
    const response = (extra: Record<string, unknown>) =>
      JSON.stringify({ stops: [stop], ...extra });

    it('accepts a single-card whole-diff tour without gist or verify', () => {
      const stops = parseChangeTour(response({}), files, true);
      expect(stops).toEqual([{ ...stop, label: 'STOP 1' }]);
      expect(stops.map(stopToCard)).toHaveLength(1);
    });

    it('wraps the stops in the gist and the verify card for a whole-diff tour', () => {
      expect(parseChangeTour(response({ gist, verify }), files, true)).toEqual([
        { ...gist, label: GIST_LABEL, tone: 'neutral', locations: [] },
        { ...stop, label: 'STOP 1' },
        { ...verify, label: CHANGE_VERIFY_LABEL, tone: 'important' },
      ]);
    });

    it('retains valid questions on gist and verify while dropping bad suggestions', () => {
      const stops = parseChangeTour(
        response({
          gist: { ...gist, questions: ['  Why this direction? ', null] },
          verify: { ...verify, questions: ['What if a caller expects old?', ' '.repeat(4)] },
        }),
        files,
        true,
      );
      expect(stops.map(stopToCard).map((card) => card.questions)).toEqual([
        ['Why this direction?'],
        undefined,
        ['What if a caller expects old?'],
      ]);
    });

    it('numbers unlabeled stops from one, not counting the gist', () => {
      const stops = parseChangeTour(response({ gist }), files, true);
      expect(stops.map(stopToCard).map((card) => card.label)).toEqual([GIST_LABEL, 'STOP 1']);
    });

    it('ignores them in one part of a split diff', () => {
      expect(parseChangeTour(response({ gist, verify }), files)).toEqual([stop]);
    });

    it('drops a malformed gist, and verify locations outside the diff, instead of failing', () => {
      const outside = { ...verify, locations: [{ filePath: 'missing.ts', line: 1 }] };
      expect(
        parseChangeTour(
          response({ gist: { title: 'No explanation' }, verify: outside }),
          files,
          true,
        ),
      ).toEqual([
        { ...stop, label: 'STOP 1' },
        { ...outside, label: CHANGE_VERIFY_LABEL, tone: 'important', locations: [] },
      ]);
    });

    it('offers optional gist and verify only when one request covers the whole diff', () => {
      expect(buildChangeTourPrompts('Task', diff)[0]).toContain('verify closes the tour');
      const large = `diff --git a/big.ts b/big.ts\n@@ -1 +1 @@\n-${'x'.repeat(CHANGE_TOUR_PROMPT_LIMIT)}\n+y\n`;
      for (const prompt of buildChangeTourPrompts('Task', large))
        expect(prompt).not.toContain('verify closes the tour');
    });

    it('replays only the file list to a gist follow-up when the diff is huge', () => {
      const other = `diff --git a/other.ts b/other.ts\n@@ -1 +1 @@\n-${'y'.repeat(400_000)}\n+z\n`;
      const { context } = changeFollowUpContext(diff + other, { ...stop, locations: [] });
      expect(context).toBe('M file.ts\nM other.ts');
    });
  });

  it.each([
    [{ endLine: 3 }, { endLine: 3 }],
    [{ endLine: 1 }, {}],
    [{ endLine: 500 }, {}],
    [{ endLine: '3' }, {}],
  ])('keeps a tight endLine range and drops any other (%o)', (range, expected) => {
    const ranged = { ...stop, locations: [{ filePath: 'file.ts', line: 1, ...range }] };
    expect(parseChangeTour(JSON.stringify({ stops: [ranged] }), files)[0].locations).toEqual([
      { filePath: 'file.ts', line: 1, ...expected },
    ]);
  });

  it("replays the whole diff to a follow-up, or only the stop's files when it is huge", () => {
    expect(changeFollowUpContext(diff, stop)).toEqual({
      context: diff,
      contextNote: 'the diff the tour was built from',
    });
    const other = `diff --git a/other.ts b/other.ts\n@@ -1 +1 @@\n-${'y'.repeat(400_000)}\n+z\n`;
    const { context, contextNote } = changeFollowUpContext(diff + other, stop);
    expect(context).toBe(diff);
    expect(contextNote).toContain("only the diff of this stop's files");
  });

  it('rejects invented paths and lines', () => {
    for (const location of [
      { filePath: 'invented.ts', line: 1 },
      { filePath: 'file.ts', line: 999 },
      { filePath: 'file.ts', line: -1 },
    ]) {
      expect(() =>
        parseChangeTour(JSON.stringify({ stops: [{ ...stop, locations: [location] }] }), files),
      ).toThrow();
    }
  });
  it('rejects malformed output instead of displaying an unlinked explanation', () => {
    for (const response of ['not json', '{}', '{"stops":[]}', '{"stops":[null]}'])
      expect(() => parseChangeTour(response, files)).toThrow();
  });
  it('includes the exact diff in one request when it fits', () => {
    const [prompt] = buildChangeTourPrompts('Task', diff);
    expect(prompt).toContain(JSON.stringify(diff));
    expect(prompt).toContain('never claim they passed');
    expect(prompt).toContain('Scale the tour to the number of distinct ideas');
    expect(buildChangeTourPrompts('Task', diff)).toHaveLength(1);
    expect(() => buildChangeTourPrompts('Task', '')).toThrow('no code changes');
  });

  it('fits a representative 600-line change into one request under the backend limit', () => {
    const removed = Array.from({ length: 300 }, (_, i) => `-const old${i} = "${'a'.repeat(100)}";`);
    const added = Array.from({ length: 300 }, (_, i) => `+const next${i} = "${'b'.repeat(100)}";`);
    const raw = `diff --git a/file.ts b/file.ts\n@@ -1,300 +1,300 @@\n${[...removed, ...added].join('\n')}\n`;
    const prompts = buildChangeTourPrompts('Task', raw);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].length).toBeGreaterThan(50_000);
    expect(prompts[0].length).toBeLessThanOrEqual(CHANGE_TOUR_PROMPT_LIMIT);
    expect(prompts[0]).toContain(JSON.stringify(raw));
  });

  it('keeps a multi-file change near the tour budget in one coherent request', () => {
    const blocks = Array.from(
      { length: 4 },
      (_, i) =>
        `diff --git a/file${i}.ts b/file${i}.ts\n@@ -1 +1 @@\n-old\n+${'x'.repeat(Math.floor(CHANGE_TOUR_PROMPT_LIMIT / 5))}\n`,
    );
    const raw = blocks.join('');
    const prompts = buildChangeTourPrompts('Task', raw);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(JSON.stringify(raw));
    expect(prompts[0]).toContain('Scale the tour to the number of distinct ideas');
  });

  it('splits many files into bounded requests without omitting later files', () => {
    const blocks = Array.from(
      { length: 100 },
      (_, i) =>
        `diff --git a/file${i}.ts b/file${i}.ts\n@@ -1 +1 @@\n-${'a'.repeat(Math.ceil(CHANGE_TOUR_PROMPT_LIMIT / 100))}\n+file${i} ${'b'.repeat(Math.ceil(CHANGE_TOUR_PROMPT_LIMIT / 100))}\n`,
    );
    const prompts = buildChangeTourPrompts('Task', blocks.join(''));
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts.every((prompt) => prompt.length <= CHANGE_TOUR_PROMPT_LIMIT)).toBe(true);
    expect(prompts.every((prompt) => prompt.includes('1-2 concise stops for this part'))).toBe(
      true,
    );
    for (const block of blocks) {
      expect(prompts.some((prompt) => prompt.includes(JSON.stringify(block).slice(1, -1)))).toBe(
        true,
      );
    }
  });

  it('splits an oversized file while preserving original line numbers and all contents', () => {
    const lines = Array.from(
      { length: Math.ceil(CHANGE_TOUR_PROMPT_LIMIT / 50) },
      (_, i) => `line-${i}-${'\\"'.repeat(25)}`,
    );
    const raw = `diff --git a/large.ts b/large.ts\nnew file mode 100644\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => '+' + line).join('\n')}\n`;
    const prompts = buildChangeTourPrompts('Task', raw);
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts.every((prompt) => prompt.length <= CHANGE_TOUR_PROMPT_LIMIT)).toBe(true);
    const contexts = prompts.map(
      (prompt) => JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as string,
    );
    expect(contexts.every((context) => !context.includes('old:'))).toBe(true);
    const records = contexts.flatMap((context) =>
      parseUnifiedDiff(context).flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines)),
    );
    expect(records.map((line) => line.content)).toEqual(lines);
    expect(records.map((line) => line.newLine)).toEqual(lines.map((_, i) => i + 1));
    expect(contexts.every((context) => context.includes('new file mode 100644'))).toBe(true);
  });

  it('preserves mixed additions, deletions and context when splitting hunks', () => {
    const content = 'x'.repeat(Math.ceil(CHANGE_TOUR_PROMPT_LIMIT / 300));
    const body = Array.from(
      { length: 600 },
      (_, i) => `${['-', '+', ' '][i % 3]}${i}${content}\n`,
    ).join('');
    const raw = `diff --git a/file.ts b/file.ts\n@@ -40,400 +60,400 @@\n${body}`;
    const prompts = buildChangeTourPrompts('Task', raw);
    expect(prompts.length).toBeGreaterThan(1);
    const lines = prompts.flatMap((prompt) => {
      expect(prompt.length).toBeLessThanOrEqual(CHANGE_TOUR_PROMPT_LIMIT);
      const context = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as string;
      return parseUnifiedDiff(context).flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines));
    });
    expect(lines).toEqual(parseUnifiedDiff(raw)[0].hunks[0].lines);
  });

  it('handles a single very long line using labeled fragments instead of truncation', () => {
    const content = '\u0000'.repeat(CHANGE_TOUR_PROMPT_LIMIT);
    const raw = `diff --git a/long.ts b/long.ts\n@@ -0,0 +1,2 @@\n+${content}\n+tail\n`;
    const prompts = buildChangeTourPrompts('Task', raw);
    expect(prompts.every((prompt) => prompt.length <= CHANGE_TOUR_PROMPT_LIMIT)).toBe(true);
    const contexts = prompts.map(
      (prompt) => JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as string,
    );
    const fragments = contexts
      .join('\n')
      .split('\n')
      .filter((line) => line.startsWith('old:'));
    expect(
      fragments
        .map(
          (record) =>
            JSON.parse(record.replace(/^old:- new:1 add fragment \d+\/\d+ /, '')) as string,
        )
        .join(''),
    ).toBe(content);
    const tail = contexts.flatMap((context) =>
      parseUnifiedDiff(context).flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines)),
    );
    expect(tail).toEqual([{ type: 'add', content: 'tail', oldLine: null, newLine: 2 }]);
  });

  it('preserves old-side ranges when splitting a deleted file', () => {
    const body = Array.from(
      { length: 600 },
      (_, i) => `-${i}${'x'.repeat(Math.ceil(CHANGE_TOUR_PROMPT_LIMIT / 300))}\n`,
    ).join('');
    const raw = `diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n@@ -1,600 +0,0 @@\n${body}`;
    const prompts = buildChangeTourPrompts('Task', raw);
    expect(prompts.length).toBeGreaterThan(1);
    const lines = prompts.flatMap((prompt) => {
      const context = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as string;
      const file = parseUnifiedDiff(context)[0];
      expect(file.status).toBe('D');
      return file.hunks.flatMap((hunk) => hunk.lines);
    });
    expect(lines).toEqual(parseUnifiedDiff(raw)[0].hunks[0].lines);
  });
});
