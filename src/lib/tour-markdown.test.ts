import { describe, expect, it } from 'vitest';
import { tourMarkdown } from './tour-markdown';
import type { TourCard } from './understanding-tour';

const gist: TourCard = {
  label: 'THE GIST',
  title: 'Output is batched',
  body: 'Fewer IPC messages.',
  tone: 'important',
  refs: [],
};
const risk: TourCard = {
  label: 'GOTCHA',
  title: 'Flush on exit',
  body: 'Lost output otherwise.',
  tone: 'risk',
  whyItMatters: 'The last lines vanish.',
  diagram: { kind: 'text', source: 'PTY -> ``` -> IPC' },
  refs: [{ filePath: 'electron/ipc/pty.ts', line: 189 }, { filePath: 'README.md' }],
};

describe('tourMarkdown', () => {
  it('quotes a card source and lists omitted sections at the end', () => {
    const quoted: TourCard = {
      label: 'KEY DECISION',
      title: 'Buffer first',
      body: 'Body.',
      tone: 'neutral',
      source: 'We keep the buffer before IPC.',
      refs: [],
    };
    const markdown = tourMarkdown({
      title: 'Tour',
      cards: [quoted],
      threads: [],
      omitted: ['Appendix'],
    });
    expect(markdown).toContain('> Source: “We keep the buffer before IPC.”');
    expect(markdown.trimEnd().endsWith('_Not covered: Appendix_')).toBe(true);
  });

  it('renders a comparison as two labelled points and a ref range', () => {
    const compared: TourCard = {
      ...gist,
      comparison: [
        { label: 'Before', text: 'One message per chunk.' },
        { label: 'After', text: 'One per flush.' },
      ],
      refs: [{ filePath: 'a.ts', line: 3, endLine: 7 }],
    };
    const markdown = tourMarkdown({ title: 'Tour', cards: [compared], threads: [] });
    expect(markdown).toContain('- **Before:** One message per chunk.\n- **After:** One per flush.');
    expect(markdown).toContain('Refs: `a.ts:3-7`');
  });

  it('renders every card in order with its label, diagram, why and refs', () => {
    const markdown = tourMarkdown({ title: 'Tour: pty.ts', cards: [gist, risk], threads: [] });
    expect(markdown).toBe(`# Tour: pty.ts

## 1. Output is batched

**THE GIST**

Fewer IPC messages.

---

## 2. Flush on exit

**⚠ GOTCHA**

Lost output otherwise.

\`\`\`\`text
PTY -> \`\`\` -> IPC
\`\`\`\`

> **Why this matters:** The last lines vanish.

Refs: \`electron/ipc/pty.ts:189\`, \`README.md\`
`);
  });

  it('puts answered follow-ups under the card they were asked from', () => {
    const markdown = tourMarkdown({
      title: 'Tour',
      cards: [gist, risk],
      threads: [{ fromIndex: 0, question: 'Why batch?', cards: [{ ...gist, title: 'Answer' }] }],
    });
    const [first, second] = markdown.split('\n---\n');
    expect(first).toContain('### ↳ Why batch?\n\n#### Answer');
    expect(second).not.toContain('Why batch?');
  });
});
