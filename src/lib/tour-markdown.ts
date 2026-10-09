import type { TourBranch, TourCard, TourRef } from './understanding-tour';

const WARNED = new Set(['risk', 'uncertainty']);

function refText(ref: TourRef): string {
  const range = ref.endLine === undefined ? `${ref.line}` : `${ref.line}-${ref.endLine}`;
  return `\`${ref.line === undefined ? ref.filePath : `${ref.filePath}:${range}`}\``;
}

/** Longer than any backtick run in the source, so a diagram cannot close its own fence. */
function fence(source: string): string {
  const longest = Math.max(2, ...(source.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(longest + 1);
}

function cardMarkdown(card: TourCard, heading: string): string {
  const label = `${WARNED.has(card.tone) ? '⚠ ' : ''}${card.label}`;
  const parts = [`${heading} ${card.title}`, `**${label}**`, card.body];
  if (card.diagram) {
    const marks = fence(card.diagram.source);
    const lang = card.diagram.kind === 'mermaid' ? 'mermaid' : 'text';
    parts.push(`${marks}${lang}\n${card.diagram.source}\n${marks}`);
  }
  if (card.comparison)
    parts.push(card.comparison.map((side) => `- **${side.label}:** ${side.text}`).join('\n'));
  if (card.source) parts.push(`> Source: “${card.source}”`);
  if (card.whyItMatters) parts.push(`> **Why this matters:** ${card.whyItMatters}`);
  if (card.refs.length) parts.push(`Refs: ${card.refs.map(refText).join(', ')}`);
  return parts.join('\n\n');
}

/**
 * A tour as Markdown for pasting into a PR description, review or notes: every
 * card in reading order, with the follow-ups answered under each one.
 */
export function tourMarkdown(input: {
  title: string;
  cards: TourCard[];
  threads: TourBranch[];
  /** Sections the tour left out, listed after the last card. */
  omitted?: string[];
}): string {
  const sections = input.cards.map((card, index) => {
    const answers = input.threads
      .filter((thread) => thread.fromIndex === index)
      .map((thread) =>
        [
          `### ↳ ${thread.question}`,
          ...thread.cards.map((answer) => cardMarkdown(answer, '####')),
        ].join('\n\n'),
      );
    return [cardMarkdown(card, `## ${index + 1}.`), ...answers].join('\n\n');
  });
  const omitted = input.omitted?.length ? `\n\n_Not covered: ${input.omitted.join(', ')}_` : '';
  return `# ${input.title}\n\n${sections.join('\n\n---\n\n')}${omitted}\n`;
}
