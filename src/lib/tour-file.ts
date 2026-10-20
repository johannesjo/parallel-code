/**
 * A tour as Markdown, in both directions: the Copy button's text and the
 * `.tour.md` file a reader saves into the worktree to revisit later. Each card
 * is a heading one level below its parent's, so the file reads as an outline
 * on GitHub and stays editable by hand or by the agent. What Markdown cannot
 * show (tone, form, the question a card answers, which blocks the card has)
 * rides in one HTML comment per card. See docs/tour-outline.md.
 */

import {
  TOUR_FILE_MAX_CARDS,
  TOUR_FILE_MAX_CHARS,
  TOUR_FILE_SUFFIX,
  TOUR_FORMS,
  TOUR_TONES,
} from '../../electron/shared/understanding-limits';
import { MAX_TOUR_DEPTH, countNodes, createNodeIds, type TourNode } from './tour-tree';
import type {
  TourCard,
  TourDiagram,
  TourForm,
  TourRef,
  TourSide,
  TourTone,
  UnderstandingTourKind,
} from './understanding-tour';

const TOUR_FILE_VERSION = 1;

/**
 * What a saved tour is of: one of the generated kinds, or a tour the reader
 * wrote themselves, which opens with its cards editable.
 */
export type TourFileKind = UnderstandingTourKind | 'thinking';

const KINDS: readonly TourFileKind[] = ['plan', 'file', 'document', 'agent', 'thinking'];
const WARNED = new Set<TourTone>(['risk', 'uncertainty']);
const META_PREFIX = '<!-- tour-card ';
const SOURCE_PREFIX = '> Source: “';
const WHY_PREFIX = '> **Why this matters:** ';
const REFS_PREFIX = 'Refs: ';

export interface TourFile {
  subject: string;
  kind: TourFileKind;
  /** Worktree-relative path of the text or file the tour explains, when there is one. */
  source?: string;
  /** Headings of the source the tour left out on purpose. */
  omitted?: string[];
  roots: TourNode[];
}

export function isTourFilePath(path: string): boolean {
  return path.toLowerCase().endsWith(TOUR_FILE_SUFFIX);
}

/** A file name for a tour of `subject`: its last path segment, made safe. */
export function tourFileName(subject: string): string {
  const base = subject.split('/').pop() ?? subject;
  const slug = base
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'tour'}${TOUR_FILE_SUFFIX}`;
}

/** One line, without a regular expression a long run of spaces could stall. */
function oneLine(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
}

/** Hand-edited files are not bound by the model's caps, but stay readable. */
const READ_CAPS = {
  title: 300,
  label: 80,
  point: 300,
  text: 8000,
  line: 1000,
} as const;

function capped(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap - 1)}…` : text;
}

/** Longer than any backtick run in the source, so a diagram cannot close its own fence. */
function fence(source: string): string {
  let longest = 2;
  let run = 0;
  for (const char of source) {
    run = char === '`' ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return '`'.repeat(longest + 1);
}

/**
 * The marker of a line that opens a fenced code block. As in CommonMark, a
 * backtick fence's info string has no backticks, so a line of inline code
 * such as "```npm i``` installs" opens nothing.
 */
function fenceOpen(line: string): { marker: string; info: string } | undefined {
  const match = /^(`{3,})([^`]*)$|^(~{3,})(.*)$/.exec(line);
  if (!match) return undefined;
  return { marker: match[1] ?? match[3], info: (match[2] ?? match[4]).trim() };
}

function closesFence(line: string, marker: string): boolean {
  const trimmed = line.trim();
  let length = 0;
  while (trimmed[length] === marker[0]) length += 1;
  return length >= marker.length && length === trimmed.length;
}

/**
 * Whether each line sits inside a fenced code block, the fence lines included,
 * and the marker of a fence still open after the last line.
 */
function fenceState(lines: readonly string[]): { fenced: boolean[]; open?: string } {
  const fenced: boolean[] = [];
  let open: string | undefined;
  for (const line of lines) {
    if (open) {
      fenced.push(true);
      if (closesFence(line, open)) open = undefined;
      continue;
    }
    open = fenceOpen(line)?.marker;
    fenced.push(open !== undefined);
  }
  return { fenced, open };
}

/** Lines the reader takes as structure, so card text writes them escaped. */
const NOTES_OPEN = '<details><summary>Notes</summary>';
const NOTES_CLOSE = '</details>';
/** Separates a card's points from a body that may end in a list of its own. */
const POINTS_MARK = '<!-- points -->';
const MARKERS = new Set([NOTES_OPEN, NOTES_CLOSE, POINTS_MARK]);

/** A line outside code that the reader would take as structure rather than text. */
function needsEscape(line: string): boolean {
  return line.startsWith('#') || MARKERS.has(line.trim());
}

/**
 * Card text as it goes into the file: never a heading of its own, which would
 * split the card in two, never one of the reader's markers, and never an
 * unclosed fence, which would swallow the cards after it. Escaped lines start
 * with a backslash, which Markdown renders as the plain line.
 */
function blockText(markdown: string): string {
  const lines = markdown.split('\n');
  const { fenced, open } = fenceState(lines);
  const out = lines.map((line, index) =>
    !fenced[index] && needsEscape(line) ? `\\${line}` : line,
  );
  if (open) out.push(open);
  return out.join('\n');
}

function unescapeLines(lines: readonly string[]): string {
  const { fenced } = fenceState(lines);
  return lines
    .map((line, index) =>
      !fenced[index] && line.startsWith('\\') && needsEscape(line.slice(1)) ? line.slice(1) : line,
    )
    .join('\n');
}

/** A trailing "#" would read as a heading's closing sequence, so it is escaped. */
function headingText(title: string): string {
  const text = oneLine(title);
  return text.endsWith('#') ? `${text.slice(0, -1)}\\#` : text;
}

/** A heading line's level and text, or undefined; linear in the line's length. */
function readHeading(line: string): { level: number; text: string } | undefined {
  let level = 0;
  while (line[level] === '#' && level < 7) level += 1;
  if (level === 0 || level > 6) return undefined;
  if (line.length > level && line[level] !== ' ' && line[level] !== '\t') return undefined;
  let text = line.slice(level).trim();
  // An optional closing sequence: spaces, then only "#" to the end.
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end -= 1;
  if (end === 0) text = '';
  else if (end < text.length && /\s/.test(text[end - 1])) text = text.slice(0, end).trim();
  if (text.endsWith('\\#')) text = `${text.slice(0, -2)}#`;
  return { level, text };
}

function refText(ref: TourRef): string {
  const range = ref.endLine === undefined ? `${ref.line}` : `${ref.line}-${ref.endLine}`;
  return `\`${ref.line === undefined ? ref.filePath : `${ref.filePath}:${range}`}\``;
}

/** JSON that cannot end the HTML comment it sits in. */
function commentJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

function tableCell(text: string): string {
  return oneLine(text).replace(/\|/g, '\\|');
}

/** The blocks a written card has, in the order the writer puts them. */
type CardField =
  | 'label'
  | 'diagram'
  | 'comparison'
  | 'body'
  | 'points'
  | 'notes'
  | 'source'
  | 'why'
  | 'refs';

function cardFields(card: TourCard): CardField[] {
  const present: [CardField, unknown][] = [
    ['label', card.label.trim()],
    ['diagram', card.diagram],
    ['comparison', card.comparison],
    ['body', card.body],
    ['points', card.points?.length],
    ['notes', card.notes],
    ['source', card.source],
    ['why', card.whyItMatters],
    ['refs', card.refs.length],
  ];
  return present.filter(([, value]) => value).map(([field]) => field);
}

/**
 * What Markdown cannot show, plus the blocks the card has: with them the
 * reader knows a table, fence or list in the body is body, not a comparison,
 * a diagram or the points.
 */
function cardMeta(node: TourNode): Record<string, unknown> {
  const { card } = node;
  return {
    ...(card.tone !== 'neutral' && { tone: card.tone }),
    ...(card.form && { form: card.form }),
    ...(node.question !== undefined && { question: node.question }),
    ...(card.questions && { questions: card.questions }),
    fields: cardFields(card),
  };
}

function cardMarkdown(node: TourNode, depth: number, withMeta: boolean): string {
  const { card } = node;
  const parts = [`${'#'.repeat(depth + 1)} ${headingText(card.title)}`];
  const label = `${WARNED.has(card.tone) ? '⚠ ' : ''}${oneLine(card.label).replace(/\*/g, '\\*')}`;
  parts.push(
    [
      ...(withMeta ? [`${META_PREFIX}${commentJson(cardMeta(node))} -->`] : []),
      ...(card.label.trim() ? [`**${label}**`] : []),
    ].join('\n'),
  );
  if (card.diagram) {
    const marks = fence(card.diagram.source);
    const lang = card.diagram.kind === 'mermaid' ? 'mermaid' : 'text';
    parts.push(`${marks}${lang}\n${card.diagram.source}\n${marks}`);
  }
  if (card.comparison) {
    const [left, right] = card.comparison;
    parts.push(
      `| ${tableCell(left.label)} | ${tableCell(right.label)} |\n| --- | --- |\n| ${tableCell(left.text)} | ${tableCell(right.text)} |`,
    );
  }
  if (card.body) parts.push(blockText(card.body));
  if (card.points?.length) {
    const list = card.points.map((point) => `- ${oneLine(point)}`).join('\n');
    parts.push(withMeta && card.body ? `${POINTS_MARK}\n${list}` : list);
  }
  if (card.notes) parts.push(`${NOTES_OPEN}\n\n${blockText(card.notes)}\n\n${NOTES_CLOSE}`);
  if (card.source) parts.push(`${SOURCE_PREFIX}${oneLine(card.source)}”`);
  if (card.whyItMatters) parts.push(`${WHY_PREFIX}${oneLine(card.whyItMatters)}`);
  if (card.refs.length) parts.push(`${REFS_PREFIX}${card.refs.map(refText).join(', ')}`);
  return parts.filter(Boolean).join('\n\n');
}

function treeMarkdown(nodes: readonly TourNode[], depth: number, withMeta: boolean): string[] {
  return nodes.flatMap((node) => [
    cardMarkdown(node, depth, withMeta),
    ...treeMarkdown(node.children, depth + 1, withMeta),
  ]);
}

/**
 * The tour as Markdown. A saved file carries front matter and the metadata
 * comments so the app can open it as a tour again; copied text leaves both out
 * and lists the omitted sections in prose instead.
 */
export function serializeTour(tour: TourFile, options: { forFile: boolean }): string {
  const header = options.forFile
    ? [
        '---',
        `parallel-code-tour: ${TOUR_FILE_VERSION}`,
        `kind: ${tour.kind}`,
        `subject: ${JSON.stringify(tour.subject)}`,
        ...(tour.source ? [`source: ${JSON.stringify(tour.source)}`] : []),
        ...(tour.omitted?.length ? [`omitted: ${JSON.stringify(tour.omitted)}`] : []),
        '---',
        '',
        `# ${headingText(tour.subject)}`,
      ]
    : [`# Tour: ${headingText(tour.subject)}`];
  const omitted =
    !options.forFile && tour.omitted?.length ? [`_Not covered: ${tour.omitted.join(', ')}_`] : [];
  return `${[header.join('\n'), ...treeMarkdown(tour.roots, 1, options.forFile), ...omitted].join('\n\n')}\n`;
}

/**
 * One card for the agent chat: which tour, where in it, what the card says,
 * and the saved file the agent can read for the rest. Staged in the prompt,
 * never sent on its own.
 */
export function cardReference(input: {
  subject: string;
  savedPath?: string;
  /** The card and the cards above it, outermost first. */
  trail: readonly TourNode[];
}): string {
  const node = input.trail.at(-1);
  if (!node) return '';
  const lines = [
    `Tour card reference — tour: ${oneLine(input.subject)}`,
    `Position: ${input.trail.map((entry) => oneLine(entry.card.title)).join(' › ')}`,
  ];
  if (node.question !== undefined) lines.push(`Asked: ${oneLine(node.question)}`);
  if (input.savedPath)
    lines.push(
      `The whole tour is saved in ${input.savedPath}; read it for the cards around this one.`,
    );
  return `${lines.join('\n')}\n\n${cardMarkdown(node, 2, false)}`;
}

/** The reader's notes from a tour, for the task's agent, naming the tour they came from. */
export function notesReference(input: {
  subject: string;
  savedPath?: string;
  notes: string;
}): string {
  const notes = input.notes.trim();
  if (!notes) return '';
  const lines = [`Notes from the tour: ${oneLine(input.subject)}`];
  if (input.savedPath) lines.push(`The whole tour is saved in ${input.savedPath}.`);
  return `${lines.join('\n')}\n\n${notes}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A front matter value: JSON when it parses, a single-quoted or bare YAML scalar otherwise. */
function frontMatterValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const quoted = /^'(.*)'$/.exec(raw);
    return quoted ? quoted[1].replace(/''/g, "'") : raw;
  }
}

function readFrontMatter(lines: string[]): { values: Map<string, unknown>; body: string[] } {
  const values = new Map<string, unknown>();
  if (lines[0]?.trim() !== '---') return { values, body: lines };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) return { values, body: lines };
  for (const line of lines.slice(1, end)) {
    const match = /^([\w-]+):[ \t]*(.*)$/.exec(line);
    if (match) values.set(match[1], frontMatterValue(match[2].trim()));
  }
  return { values, body: lines.slice(end + 1) };
}

function readMeta(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith(META_PREFIX) || !line.endsWith('-->')) return undefined;
  try {
    return asRecord(JSON.parse(line.slice(META_PREFIX.length, -3).trim()));
  } catch {
    return undefined;
  }
}

function readRefs(line: string): TourRef[] {
  const refs: TourRef[] = [];
  for (const match of line.matchAll(/`([^`]+)`/g)) {
    const ref = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(match[1].trim());
    if (!ref?.[1]) continue;
    refs.push({
      filePath: ref[1],
      ...(ref[2] && { line: Number(ref[2]) }),
      ...(ref[3] && { endLine: Number(ref[3]) }),
    });
  }
  return refs;
}

function splitCells(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((cell) => capped(cell.trim().replace(/\\\|/g, '|'), READ_CAPS.line));
}

function readComparison(rows: string[]): [TourSide, TourSide] | undefined {
  if (rows.length < 3) return undefined;
  const labels = splitCells(rows[0]);
  const texts = splitCells(rows[2]);
  if (labels.length !== 2 || texts.length !== 2) return undefined;
  return [
    { label: labels[0], text: texts[0] },
    { label: labels[1], text: texts[1] },
  ];
}

function readTone(value: unknown): TourTone {
  return (TOUR_TONES as readonly unknown[]).includes(value) ? (value as TourTone) : 'neutral';
}

function readForm(
  value: unknown,
  evidence: { diagram?: TourDiagram; comparison?: [TourSide, TourSide] },
): TourForm | undefined {
  if (!(TOUR_FORMS as readonly unknown[]).includes(value)) return undefined;
  if (value === 'flow' && !evidence.diagram) return undefined;
  if (value === 'comparison' && !evidence.comparison) return undefined;
  return value as TourForm;
}

function readQuestions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const questions = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => capped(entry, READ_CAPS.line));
  return questions.length ? questions : undefined;
}

/** The parts of a card the readers below fill in. */
interface CardParts {
  label: string;
  diagram?: TourDiagram;
  comparison?: [TourSide, TourSide];
  body: string[];
  points: string[];
  notes?: string;
  source?: string;
  whyItMatters?: string;
  refs: TourRef[];
}

const LIST_ITEM = /^[-*+][ \t]+/;

/** Appends without spreading, which a body of a few hundred thousand lines would overflow. */
function append(target: string[], lines: readonly string[]): void {
  for (const line of lines) target.push(line);
}

/** List items, with an indented line continuing the item above it. */
function readPoints(lines: readonly string[]): string[] {
  const points: string[] = [];
  for (const line of lines) {
    if (LIST_ITEM.test(line)) points.push(line.trim().replace(LIST_ITEM, ''));
    else if (points.length && /^\s+\S/.test(line)) points[points.length - 1] += ` ${line.trim()}`;
  }
  return points;
}

/** The lines of a fenced block opening at `start`, through its closing fence. */
function fencedBlock(lines: readonly string[], start: number): string[] {
  const opened = fenceOpen(lines[start]);
  if (!opened) return [];
  let end = start + 1;
  while (end < lines.length && !closesFence(lines[end], opened.marker)) end += 1;
  return lines.slice(start, Math.min(end + 1, lines.length));
}

/**
 * A card the app wrote: its comment lists the blocks it has, and each is read
 * only from the place the writer puts it. Everything else is body, so a body
 * with a table, a text fence or a list survives the round trip unchanged.
 */
function readDeclaredCard(lines: string[], fields: ReadonlySet<string>): CardParts {
  const parts: CardParts = { label: '', body: [], points: [], refs: [] };
  const { fenced } = fenceState(lines);
  let start = 0;
  let end = lines.length;
  const lastLine = () => {
    while (end > start && !lines[end - 1].trim()) end -= 1;
    return end > start && !fenced[end - 1] ? lines[end - 1].trim() : '';
  };
  const firstLine = () => {
    while (start < end && !lines[start].trim()) start += 1;
    return start < end ? lines[start].trim() : '';
  };

  if (fields.has('refs') && lastLine().startsWith(REFS_PREFIX)) {
    parts.refs = readRefs(lastLine());
    end -= 1;
  }
  if (fields.has('why') && lastLine().startsWith(WHY_PREFIX)) {
    parts.whyItMatters = capped(lastLine().slice(WHY_PREFIX.length), READ_CAPS.line);
    end -= 1;
  }
  const source = lastLine();
  if (fields.has('source') && source.startsWith(SOURCE_PREFIX) && source.endsWith('”')) {
    parts.source = capped(source.slice(SOURCE_PREFIX.length, -1), READ_CAPS.line);
    end -= 1;
  }
  if (fields.has('notes') && lastLine() === NOTES_CLOSE) {
    let open = end - 2;
    while (open >= start && (fenced[open] || lines[open].trim() !== NOTES_OPEN)) open -= 1;
    if (open >= start) {
      const notes = unescapeLines(lines.slice(open + 1, end - 1)).trim();
      if (notes) parts.notes = capped(notes, READ_CAPS.text);
      end = open;
    }
  }

  const bold = /^\*\*(.+)\*\*$/.exec(firstLine());
  if (fields.has('label') && bold) {
    parts.label = bold[1].replace(/^⚠\s*/, '').replace(/\\\*/g, '*');
    start += 1;
  }
  if (fields.has('diagram')) {
    firstLine();
    const opened = start < end ? fenceOpen(lines[start]) : undefined;
    if (opened && (opened.info === 'text' || opened.info === 'mermaid')) {
      const block = fencedBlock(lines, start);
      parts.diagram = {
        kind: opened.info,
        source: capped(block.slice(1, -1).join('\n'), READ_CAPS.text),
      };
      start += block.length;
    }
  }
  if (fields.has('comparison') && firstLine().startsWith('|')) {
    const rows: string[] = [];
    while (start < end && lines[start].trim().startsWith('|')) rows.push(lines[start++].trim());
    parts.comparison = readComparison(rows);
    if (!parts.comparison) append(parts.body, rows);
  }

  const middle = lines.slice(start, end);
  if (!fields.has('points')) {
    append(parts.body, middle);
    return parts;
  }
  const middleFenced = fenced.slice(start, end);
  // The writer's own marker is the last one; earlier ones are body text.
  const mark = middle.findLastIndex(
    (line, index) => !middleFenced[index] && line.trim() === POINTS_MARK,
  );
  if (mark >= 0) {
    append(parts.body, middle.slice(0, mark));
    parts.points = readPoints(middle.slice(mark + 1));
  } else if (fields.has('body')) {
    // Marker removed by hand: the list at the end is taken as the points.
    let split = middle.length;
    while (
      split > 0 &&
      (!middle[split - 1].trim() ||
        LIST_ITEM.test(middle[split - 1]) ||
        /^\s+\S/.test(middle[split - 1]))
    )
      split -= 1;
    append(parts.body, middle.slice(0, split));
    parts.points = readPoints(middle.slice(split));
  } else parts.points = readPoints(middle);
  return parts;
}

/**
 * A card written by hand, with no comment to say what it has: the blocks the
 * writer emits are recognised by their shape wherever they are, a list is the
 * points and anything else is body.
 */
function readLooseCard(lines: string[]): CardParts {
  const parts: CardParts = { label: '', body: [], points: [], refs: [] };
  const { fenced } = fenceState(lines);
  let labelAllowed = true;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      if (parts.body.length && parts.body.at(-1) !== '') parts.body.push('');
      index += 1;
      continue;
    }
    const opened = fenceOpen(line);
    if (opened) {
      const block = fencedBlock(lines, index);
      index += block.length;
      labelAllowed = false;
      if (
        !parts.diagram &&
        (opened.info === 'text' || opened.info === 'mermaid') &&
        block.length >= 2
      )
        parts.diagram = {
          kind: opened.info,
          source: capped(block.slice(1, -1).join('\n'), READ_CAPS.text),
        };
      else append(parts.body, block);
      continue;
    }
    if (trimmed === NOTES_OPEN) {
      let close = index + 1;
      while (close < lines.length && (fenced[close] || lines[close].trim() !== NOTES_CLOSE))
        close += 1;
      const notes = unescapeLines(lines.slice(index + 1, close)).trim();
      if (notes) parts.notes = capped(notes, READ_CAPS.text);
      index = close + 1;
      labelAllowed = false;
      continue;
    }
    const bold = /^\*\*(.+)\*\*$/.exec(trimmed);
    if (labelAllowed && bold) {
      parts.label = bold[1].replace(/^⚠\s*/, '').replace(/\\\*/g, '*');
      labelAllowed = false;
      index += 1;
      continue;
    }
    labelAllowed = false;
    if (trimmed.startsWith(SOURCE_PREFIX) && trimmed.endsWith('”')) {
      parts.source = capped(trimmed.slice(SOURCE_PREFIX.length, -1), READ_CAPS.line);
    } else if (trimmed.startsWith(WHY_PREFIX)) {
      parts.whyItMatters = capped(trimmed.slice(WHY_PREFIX.length), READ_CAPS.line);
    } else if (trimmed.startsWith(REFS_PREFIX) && trimmed.includes('`')) {
      parts.refs = readRefs(trimmed);
    } else if (trimmed.startsWith('|') && !parts.comparison) {
      const rows: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('|'))
        rows.push(lines[index++].trim());
      parts.comparison = readComparison(rows);
      if (!parts.comparison) append(parts.body, rows);
      continue;
    } else if (LIST_ITEM.test(line)) {
      parts.points.push(trimmed.replace(LIST_ITEM, ''));
    } else if (parts.points.length && /^\s+\S/.test(line) && parts.body.at(-1) !== '') {
      // A hand-wrapped point continues on an indented line.
      parts.points[parts.points.length - 1] += ` ${trimmed}`;
    } else {
      parts.body.push(line);
    }
    index += 1;
  }
  return parts;
}

/** One card from the lines under its heading. */
function readCard(title: string, lines: string[]): { card: TourCard; question?: string } {
  let index = 0;
  while (index < lines.length && !lines[index].trim()) index += 1;
  const meta = readMeta(lines[index]?.trim() ?? '');
  const rest = meta ? lines.slice(index + 1) : lines;
  const fields = Array.isArray(meta?.fields)
    ? new Set(meta.fields.filter((field): field is string => typeof field === 'string'))
    : undefined;
  const parts = fields ? readDeclaredCard(rest, fields) : readLooseCard(rest);
  const points = parts.points.map((point) => capped(point, READ_CAPS.point)).filter(Boolean);
  const card: TourCard = {
    label: capped(parts.label, READ_CAPS.label),
    title: capped(title, READ_CAPS.title),
    body: capped(unescapeLines(parts.body).trim(), READ_CAPS.text),
    tone: readTone(meta?.tone),
    refs: parts.refs,
    ...(points.length && { points }),
    ...(parts.notes && { notes: parts.notes }),
    ...(parts.diagram && { diagram: parts.diagram }),
    ...(parts.comparison && { comparison: parts.comparison }),
    ...(parts.whyItMatters && { whyItMatters: parts.whyItMatters }),
    ...(parts.source && { source: parts.source }),
  };
  const form = readForm(meta?.form, card);
  const questions = readQuestions(meta?.questions);
  return {
    card: { ...card, ...(form && { form }), ...(questions && { questions }) },
    ...(typeof meta?.question === 'string' && {
      question: capped(meta.question, READ_CAPS.line),
    }),
  };
}

/**
 * Reads a saved tour. Throws with a reader-facing message when the text is not
 * one: no front matter marker, or no card under the title.
 */
export function parseTourFile(text: string): TourFile {
  if (text.length > TOUR_FILE_MAX_CHARS) throw new Error('The tour file is too large.');
  const { values, body } = readFrontMatter(text.replace(/\r\n?/g, '\n').split('\n'));
  if (!values.has('parallel-code-tour')) throw new Error('This file is not a saved tour.');
  const kindValue = values.get('kind');
  const kind = KINDS.find((entry) => entry === kindValue) ?? 'agent';

  let title: string | undefined;
  const sections: { depth: number; title: string; lines: string[] }[] = [];
  const { fenced } = fenceState(body);
  body.forEach((line, index) => {
    const heading = fenced[index] ? undefined : readHeading(line);
    // Once, even when empty: a tour with no subject still writes its title line.
    if (heading?.level === 1 && !sections.length && title === undefined) {
      title = capped(heading.text, READ_CAPS.title);
      return;
    }
    if (heading && heading.level > 1) {
      sections.push({ depth: heading.level - 1, title: heading.text, lines: [] });
      return;
    }
    sections.at(-1)?.lines.push(line);
  });

  const nextId = createNodeIds();
  const roots: TourNode[] = [];
  const stack: TourNode[] = [];
  for (const section of sections) {
    // A card may have no title, as the reader can write one; only an empty heading is no card.
    if (!section.title.trim() && !section.lines.some((line) => line.trim())) continue;
    const { card, question } = readCard(section.title.trim(), section.lines);
    const node: TourNode = {
      id: nextId(),
      card,
      ...(question !== undefined && { question }),
      children: [],
    };
    // A skipped heading level nests one level down, never more.
    const depth = Math.min(section.depth, stack.length + 1, MAX_TOUR_DEPTH);
    stack.length = depth - 1;
    (stack.at(-1)?.children ?? roots).push(node);
    stack.push(node);
  }
  if (!roots.length) throw new Error('The tour file has no cards.');
  if (countNodes(roots) > TOUR_FILE_MAX_CARDS) throw new Error('The tour file has too many cards.');

  const subjectValue = values.get('subject');
  const sourceValue = values.get('source');
  const omittedValue = values.get('omitted');
  const omitted = Array.isArray(omittedValue)
    ? omittedValue.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return {
    // A thinking tour's subject is its first card's title, which may be empty.
    subject:
      (typeof subjectValue === 'string' && subjectValue.trim()) ||
      title?.trim() ||
      (kind === 'thinking' ? '' : 'Saved tour'),
    kind,
    ...(typeof sourceValue === 'string' && sourceValue.trim() && { source: sourceValue.trim() }),
    ...(omitted.length && { omitted }),
    roots,
  };
}
