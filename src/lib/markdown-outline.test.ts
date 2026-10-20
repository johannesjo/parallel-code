import { describe, expect, it } from 'vitest';
import {
  MAX_OUTLINE_HEADINGS,
  markdownOutline,
  normalizeForMatch,
  quoteAppearsIn,
  renderOutline,
} from './markdown-outline';

describe('markdownOutline', () => {
  it('lists ATX headings of levels 1-3 and strips closing hashes', () => {
    const outline = markdownOutline(
      '# Title\n\ntext\n## Goals ##\n### Detail\n#### Too deep\n#nope',
    );
    expect(outline).toEqual([
      { level: 1, text: 'Title' },
      { level: 2, text: 'Goals' },
      { level: 3, text: 'Detail' },
    ]);
  });

  it('ignores headings inside fenced code until the matching fence closes', () => {
    const text = '# Real\n````md\n# Fake\n```\n## Still fake\n````\n## After';
    expect(markdownOutline(text).map((heading) => heading.text)).toEqual(['Real', 'After']);
  });

  it('is empty for text without headings, and renders to nothing', () => {
    expect(markdownOutline('just prose\nmore prose')).toEqual([]);
    expect(renderOutline([])).toBe('');
  });

  it('thins a long outline to levels 1-2 and caps it', () => {
    const lines = Array.from({ length: 80 }, (_, i) => (i % 2 ? `### Sub ${i}` : `## Part ${i}`));
    const outline = markdownOutline(lines.join('\n'));
    expect(outline.every((heading) => heading.level <= 2)).toBe(true);
    expect(outline).toHaveLength(40);
    const many = Array.from({ length: 90 }, (_, i) => `## Part ${i}`).join('\n');
    expect(markdownOutline(many)).toHaveLength(MAX_OUTLINE_HEADINGS);
  });

  it('does not close a fence on a line with an info string', () => {
    const text = '```\n# a\n```js\n# b\n```\n# c';
    expect(markdownOutline(text).map((heading) => heading.text)).toEqual(['c']);
  });

  it('reads setext headings and skips front matter and HTML comments', () => {
    const text = [
      '---',
      'title: x',
      '# not a heading',
      '---',
      'Title',
      '=====',
      '',
      '<!-- # hidden',
      '# also hidden -->',
      'Section',
      '-------',
      '- item',
      '---',
      '',
      '---',
    ].join('\n');
    expect(markdownOutline(text)).toEqual([
      { level: 1, text: 'Title' },
      { level: 2, text: 'Section' },
    ]);
  });

  it('indents nested headings', () => {
    expect(renderOutline(markdownOutline('# A\n## B\n### C'))).toBe('- A\n  - B\n    - C');
  });
});

describe('quoteAppearsIn', () => {
  const source = normalizeForMatch(
    '## Decision\n\n- We **keep** the [buffer](https://x.dev) before IPC — always.\n' +
      'The flush runs every `16ms`, and “never” blocks the renderer.',
  );

  it('matches across Markdown markers, links, typographic quotes, dashes and case', () => {
    expect(quoteAppearsIn('We keep the buffer before IPC - always.', source)).toBe(true);
    expect(quoteAppearsIn('the flush runs every 16ms, and "never" blocks', source)).toBe(true);
  });

  it('matches fragments joined by an ellipsis, in order only', () => {
    expect(quoteAppearsIn('We keep the buffer … never" blocks the renderer', source)).toBe(true);
    expect(quoteAppearsIn('never" blocks the renderer ... We keep the buffer', source)).toBe(false);
  });

  it('matches quotes spanning list items, escapes and either kind of dash', () => {
    const list = normalizeForMatch(
      '1. Stop the worker.\n2. Drain the queue before restart.\n\nUse foo\\_bar for it.',
    );
    expect(quoteAppearsIn('1. Stop the worker.\n2. Drain the queue before restart.', list)).toBe(
      true,
    );
    expect(quoteAppearsIn('Stop the worker. Drain the queue', list)).toBe(true);
    expect(quoteAppearsIn('Use foo_bar for it.', list)).toBe(true);
    expect(quoteAppearsIn('We keep the buffer before IPC \u2014 always.', source)).toBe(true);
  });

  it('never stitches distant or many fragments into a claim the text does not make', () => {
    const text = normalizeForMatch(
      `We do not ship the buffer before IPC. ${'Filler sentence here. '.repeat(20)}` +
        'Later we will keep a fallback buffer for retries.',
    );
    expect(quoteAppearsIn('We do not … keep a fallback buffer for retries', text)).toBe(false);
    expect(
      quoteAppearsIn('We do not ship the buffer … keep a fallback buffer for retries', text),
    ).toBe(false);
    const near = normalizeForMatch('Alpha beta gamma delta. Epsilon zeta eta theta. Iota kappa.');
    expect(quoteAppearsIn('Alpha beta gamma … Epsilon zeta eta', near)).toBe(true);
    expect(quoteAppearsIn('Alpha beta gamma … Epsilon zeta eta … Iota kappa lambda', near)).toBe(
      false,
    );
  });

  it('rejects paraphrases and quotes made only of tiny fragments', () => {
    expect(quoteAppearsIn('We buffer output before IPC', source)).toBe(false);
    expect(quoteAppearsIn('keep', source)).toBe(false);
    expect(quoteAppearsIn('...', source)).toBe(false);
  });
});
