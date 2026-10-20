import type { TourCard } from './understanding-tour';

/**
 * An understanding tour as a tree of cards. The tour's own cards are the roots,
 * read in order; every follow-up answer becomes a child of the card it was
 * asked on, so a reader can dig into any card and come back out. Pure data:
 * the controller owns the state, the outline and the saved file render it.
 */
export interface TourNode {
  /** Stable within one tour; never shown. */
  id: string;
  card: TourCard;
  /** The reader's question this card answers; absent on the tour's own cards. */
  question?: string;
  children: TourNode[];
}

/**
 * Cards nest at most this deep, counting the tour's own cards as level one: a
 * saved tour gives each level a heading below the title's, and Markdown stops
 * at six.
 */
export const MAX_TOUR_DEPTH = 5;

/** Fixed question behind "Go deeper" on one point of a slide. */
const POINT_QUESTION_PREFIX = 'Go deeper on this point: ';

export function pointQuestion(point: string): string {
  return `${POINT_QUESTION_PREFIX}${point}`;
}

/** The point a "Go deeper" question was asked on, or undefined for any other question. */
export function questionPoint(question: string | undefined): string | undefined {
  return question?.startsWith(POINT_QUESTION_PREFIX)
    ? question.slice(POINT_QUESTION_PREFIX.length)
    : undefined;
}

/** Hands out ids no node of the tree uses yet. */
export function createNodeIds(roots: readonly TourNode[] = []): () => string {
  let last = 0;
  walk(roots, (node) => {
    const match = /^c(\d+)$/.exec(node.id);
    if (match) last = Math.max(last, Number(match[1]));
  });
  return () => `c${++last}`;
}

export function nodesFromCards(
  cards: readonly TourCard[],
  nextId: () => string,
  question?: string,
): TourNode[] {
  return cards.map((card) => ({
    id: nextId(),
    card,
    ...(question !== undefined && { question }),
    children: [],
  }));
}

function walk(nodes: readonly TourNode[], visit: (node: TourNode) => void): void {
  for (const node of nodes) {
    visit(node);
    walk(node.children, visit);
  }
}

export function countNodes(roots: readonly TourNode[]): number {
  let count = 0;
  walk(roots, () => (count += 1));
  return count;
}

/** The node and its ancestors, outermost first; empty when the id is unknown. */
export function nodeTrail(roots: readonly TourNode[], id: string): TourNode[] {
  for (const node of roots) {
    if (node.id === id) return [node];
    const below = nodeTrail(node.children, id);
    if (below.length) return [node, ...below];
  }
  return [];
}

export function findNode(roots: readonly TourNode[], id: string): TourNode | undefined {
  return nodeTrail(roots, id).at(-1);
}

/** The list the node sits in: the roots, or its parent's children. */
function siblingsOf(roots: readonly TourNode[], trail: readonly TourNode[]): readonly TourNode[] {
  return trail.length > 1 ? trail[trail.length - 2].children : roots;
}

/**
 * Reading order that keeps depth optional: the next card at the same level,
 * or, after the last child, the card after its parent. Children are only
 * entered on purpose, so stepping forward from the gist reads the tour's own
 * cards as before.
 */
export function nextNodeId(roots: readonly TourNode[], id: string): string | undefined {
  const trail = nodeTrail(roots, id);
  for (let depth = trail.length; depth > 0; depth -= 1) {
    const level = trail.slice(0, depth);
    const siblings = siblingsOf(roots, level);
    const index = siblings.indexOf(level[depth - 1]);
    const next = siblings[index + 1];
    if (next) return next.id;
  }
  return undefined;
}

/**
 * The card below in reading order among the answers under one tour card: the
 * first answer, else the next one, climbing out after the last child.
 * Undefined after the last answer, where the next card would be a tour card.
 */
export function belowNodeId(roots: readonly TourNode[], id: string): string | undefined {
  const first = findNode(roots, id)?.children[0];
  if (first) return first.id;
  const next = nextNodeId(roots, id);
  return next && nodeTrail(roots, next).length > 1 ? next : undefined;
}

/** The card before at the same level, or the parent from a first child. */
export function previousNodeId(roots: readonly TourNode[], id: string): string | undefined {
  const trail = nodeTrail(roots, id);
  const node = trail.at(-1);
  if (!node) return undefined;
  const siblings = siblingsOf(roots, trail);
  const index = siblings.indexOf(node);
  if (index > 0) return siblings[index - 1].id;
  return trail.length > 1 ? trail[trail.length - 2].id : undefined;
}

/** Index of the tour card the node belongs to, for the progress strip. */
export function rootIndexOf(roots: readonly TourNode[], id: string): number {
  const root = nodeTrail(roots, id)[0];
  return root ? roots.indexOf(root) : -1;
}

/**
 * The tree with `added` appended under the node `parentId`. Only the path to
 * that node is copied, so every other node keeps its identity and the views
 * rendering it do not redraw.
 */
export function appendChildren(
  roots: TourNode[],
  parentId: string,
  added: readonly TourNode[],
): TourNode[] {
  let changed = false;
  const next = roots.map((node) => {
    if (node.id === parentId) {
      changed = true;
      return { ...node, children: [...node.children, ...added] };
    }
    const children = appendChildren(node.children, parentId, added);
    if (children === node.children) return node;
    changed = true;
    return { ...node, children };
  });
  return changed ? next : roots;
}
