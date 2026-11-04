/**
 * Draws a KANBAN.md board as a mind map: board title → columns → cards →
 * checklist items, with `depends:` lines as "waits for" links. The map is
 * derived on every render and never stored; KANBAN.md stays the only source.
 */
import type { MapData, MapLink, MapNode } from '../graph/model';
import {
  cardChecklist,
  cardSummary,
  findCardByTitle,
  isArchiveColumn,
  isCardDone,
  type KanbanBoard,
  type KanbanCard,
  type KanbanCardRef,
} from './kanban';

export interface KanbanMap {
  map: MapData;
  /** The board card each card node stands for. */
  cards: ReadonlyMap<string, KanbanCardRef>;
  /** Done cards and checked checklist items. */
  faded: ReadonlySet<string>;
  /** Branches that start folded: archive columns and cards with a checklist. */
  folded: ReadonlySet<string>;
}

export const KANBAN_MAP_ROOT = 'board';

/** FNV-1a: short, stable and within the graph ID pattern. */
function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }
  return (value >>> 0).toString(36);
}

/**
 * IDs come from titles rather than positions, so moving or reordering a card
 * keeps its node and only truly new cards get the canvas's arrival cue.
 */
function idMaker(): (prefix: string, key: string) => string {
  const used = new Set<string>();
  return (prefix, key) => {
    const base = `${prefix}-${hash(key)}`;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };
}

/** Links between card nodes for each title a card names in `titles`. */
function cardLinks(
  board: KanbanBoard,
  refs: ReadonlyMap<string, KanbanCardRef>,
  titles: (card: KanbanCard) => readonly string[],
): { source: string; target: string }[] {
  const ids = new Map([...refs].map(([id, ref]) => [`${ref.column}:${ref.card}`, id]));
  const pairs: { source: string; target: string }[] = [];
  for (const [source, ref] of refs) {
    for (const title of titles(board.columns[ref.column].cards[ref.card])) {
      const found = findCardByTitle(board, title);
      const target = found && ids.get(`${found.column}:${found.card}`);
      // A card may name the same card twice; draw it once.
      if (
        !target ||
        target === source ||
        pairs.some((p) => p.target === target && p.source === source)
      )
        continue;
      pairs.push({ source, target });
    }
  }
  return pairs;
}

/**
 * `depends:` lines as "waits for" links, and `related:` lines as "relates to"
 * links unless the pair is already linked, either way round.
 */
function boardLinks(board: KanbanBoard, refs: ReadonlyMap<string, KanbanCardRef>): MapLink[] {
  const links: MapLink[] = cardLinks(board, refs, (card) => card.depends).map((p) => ({
    id: `dep-${p.source}-${p.target}`,
    ...p,
    kind: 'waits for',
  }));
  for (const p of cardLinks(board, refs, (card) => card.related ?? [])) {
    const linked = links.some(
      (l) =>
        (l.source === p.source && l.target === p.target) ||
        (l.source === p.target && l.target === p.source),
    );
    if (!linked) links.push({ id: `rel-${p.source}-${p.target}`, ...p, kind: 'relates to' });
  }
  return links;
}

/** Whether the map hangs cards under their column or under their `group:` theme. */
export type KanbanMapGrouping = 'column' | 'theme';

export const KANBAN_NO_THEME = 'No theme';

/**
 * The board as map data. `shown` lists the card indexes to include per column,
 * so the board's search and "Needs you" filters apply to the map too; omit it
 * to include every card. Grouped by theme, archived cards are left out: the
 * themes are for the work that is still part of the plan.
 */
export function boardToMap(
  board: KanbanBoard,
  shown?: readonly (readonly number[])[],
  grouping: KanbanMapGrouping = 'column',
): KanbanMap {
  const id = idMaker();
  const records: MapNode[] = [
    { id: KANBAN_MAP_ROOT, title: board.title || 'Plan', detail: board.preamble.trim() },
  ];
  const cards = new Map<string, KanbanCardRef>();
  const faded = new Set<string>();
  const folded = new Set<string>();
  // Theme nodes by lowercased name, so "Auth" and "auth" share one branch.
  const themes = new Map<string, string>();
  const themeNode = (name: string): string => {
    const key = name.toLowerCase();
    let themeId = themes.get(key);
    if (!themeId) {
      themeId = id('theme', key);
      themes.set(key, themeId);
      records.push({ id: themeId, parent: KANBAN_MAP_ROOT, title: name, detail: '' });
    }
    return themeId;
  };
  const addCardNode = (ref: KanbanCardRef, parent: string) => {
    const card = board.columns[ref.column].cards[ref.card];
    const cardId = id('card', card.title);
    records.push({ id: cardId, parent, title: card.title, detail: cardSummary(card) });
    cards.set(cardId, ref);
    if (isCardDone(board, ref)) faded.add(cardId);
    const checklist = cardChecklist(card);
    if (checklist.length > 0) folded.add(cardId);
    for (const item of checklist) {
      const itemId = id('item', `${cardId}\n${item.text}`);
      records.push({ id: itemId, parent: cardId, title: item.text, detail: '' });
      if (item.done) faded.add(itemId);
    }
  };
  const unthemed: KanbanCardRef[] = [];
  board.columns.forEach((column, columnIndex) => {
    const archived = isArchiveColumn(column.title);
    if (grouping === 'theme' && archived) return;
    let columnId = '';
    if (grouping === 'column') {
      columnId = id('col', column.title);
      records.push({
        id: columnId,
        parent: KANBAN_MAP_ROOT,
        title: column.title,
        detail: column.notes.trim(),
      });
      if (archived) folded.add(columnId);
    }
    for (const cardIndex of shown?.[columnIndex] ?? column.cards.map((_, i) => i)) {
      const card = column.cards[cardIndex];
      if (!card) continue;
      const ref = { column: columnIndex, card: cardIndex };
      if (grouping === 'column') addCardNode(ref, columnId);
      else if (card.group?.trim()) addCardNode(ref, themeNode(card.group.trim()));
      else unthemed.push(ref);
    }
  });
  // Last, so the cards still to sort sit below the themes.
  if (unthemed.length) {
    const rest = id('theme', '\nnone');
    records.push({ id: rest, parent: KANBAN_MAP_ROOT, title: KANBAN_NO_THEME, detail: '' });
    for (const ref of unthemed) addCardNode(ref, rest);
  }
  return { map: { records, relations: boardLinks(board, cards) }, cards, faded, folded };
}
