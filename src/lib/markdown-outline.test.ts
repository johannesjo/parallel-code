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

  it('rejects paraphrases and quotes made only of tiny fragments', () => {
    expect(quoteAppearsIn('We buffer output before IPC', source)).toBe(false);
    expect(quoteAppearsIn('keep', source)).toBe(false);
    expect(quoteAppearsIn('...', source)).toBe(false);
  });
});
