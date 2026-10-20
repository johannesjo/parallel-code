import { describe, expect, it } from 'vitest';
import { MAX_TOUR_DEPTH, type TourNode } from './tour-tree';
import {
  applyWrittenCards,
  blankCard,
  editableText,
  hasWriting,
  insertAfter,
  insertChild,
  isBlankCard,
  outdent,
  removeNode,
  replaceCard,
  withText,
} from './tour-tree-edit';
import type { TourCard } from './understanding-tour';

function card(title: string): TourCard {
  return { label: '', title, body: '', tone: 'neutral', refs: [] };
}

function node(id: string, children: TourNode[] = []): TourNode {
  return { id, card: card(id), children };
}

/** The tree as `id(child child)` text, to compare shapes at a glance. */
function shape(nodes: readonly TourNode[]): string {
  return nodes
    .map((entry) => (entry.children.length ? `${entry.id}(${shape(entry.children)})` : entry.id))
    .join(' ');
}

// a (a1 a2), b
const tree = [node('a', [node('a1'), node('a2')]), node('b')];

describe('tour tree edits', () => {
  it('replaces a card and keeps untouched nodes', () => {
    const next = replaceCard(tree, 'a2', card('new'));
    expect(next[0].children[1].card.title).toBe('new');
    expect(next[0].children[0]).toBe(tree[0].children[0]);
    expect(next[1]).toBe(tree[1]);
    expect(tree[0].children[1].card.title).toBe('a2');
  });

  it('inserts a sibling after a card and a follow-up under it', () => {
    expect(shape(insertAfter(tree, 'a1', node('x')))).toBe('a(a1 x a2) b');
    expect(shape(insertAfter(tree, 'b', node('x')))).toBe('a(a1 a2) b x');
    expect(shape(insertChild(tree, 'b', node('x')))).toBe('a(a1 a2) b(x)');
    expect(shape(insertChild(tree, 'a', node('x')))).toBe('a(a1 a2 x) b');
  });

  it('outdents a card to after its parent', () => {
    expect(shape(outdent(tree, 'a1'))).toBe('a(a2) a1 b');
    expect(shape(outdent(tree, 'a2'))).toBe('a(a1) a2 b');
  });

  it('leaves the tree alone for moves it cannot take', () => {
    expect(shape(outdent(tree, 'b'))).toBe(shape(tree));
    expect(shape(replaceCard(tree, 'nope', card('x')))).toBe(shape(tree));
  });

  it('never nests deeper than a saved tour can hold', () => {
    let deep: TourNode = node(`d${MAX_TOUR_DEPTH}`);
    for (let level = MAX_TOUR_DEPTH - 1; level > 0; level -= 1) deep = node(`d${level}`, [deep]);
    const roots = [node('first'), deep];
    expect(shape(insertChild(roots, `d${MAX_TOUR_DEPTH}`, node('x')))).toBe(shape(roots));
  });

  it('removes a card and lifts its follow-ups into its place', () => {
    expect(shape(removeNode(tree, 'a'))).toBe('a1 a2 b');
    expect(shape(removeNode(tree, 'a2'))).toBe('a(a1) b');
  });
});

describe('blank cards', () => {
  it('counts a card as written once any of its text is', () => {
    expect(isBlankCard(blankCard())).toBe(true);
    expect(isBlankCard({ ...blankCard(), body: '  ' })).toBe(true);
    expect(isBlankCard({ ...blankCard(), points: ['x'] })).toBe(false);
    expect(hasWriting([{ id: 'a', card: blankCard(), children: [] }])).toBe(false);
    expect(hasWriting([{ id: 'a', card: blankCard(), children: [node('b')] }])).toBe(true);
  });
});

describe('written cards', () => {
  it('replaces the notes and proposes the rest as follow-ups', () => {
    let id = 0;
    const nextId = () => `n${++id}`;
    const next = applyWrittenCards(tree, 'b', {
      cards: [card('B!'), card('x'), card('y')],
      nextId,
    });
    expect(shape(next)).toBe('a(a1 a2) b(n1 n2)');
    expect(next[1].card.title).toBe('B!');
    expect(next[1].children.map((child) => child.card.title)).toEqual(['x', 'y']);
  });

  it('adds the rest after the card where nothing can nest deeper', () => {
    let deep: TourNode = node(`d${MAX_TOUR_DEPTH}`);
    for (let level = MAX_TOUR_DEPTH - 1; level > 0; level -= 1) deep = node(`d${level}`, [deep]);
    let id = 0;
    const next = applyWrittenCards([deep], `d${MAX_TOUR_DEPTH}`, {
      cards: [card('top'), card('x'), card('y')],
      nextId: () => `n${++id}`,
    });
    expect(shape(next)).toBe('d1(d2(d3(d4(d5 n1 n2))))');
    expect(next[0].children[0].children[0].children[0].children.map((c) => c.card.title)).toEqual([
      'top',
      'x',
      'y',
    ]);
  });
});

describe('card text', () => {
  it('edits a written card as Markdown and keeps its points while unchanged', () => {
    const written = { ...card('T'), body: 'Why', points: ['a', 'b'] };
    expect(editableText(written)).toBe('Why\n\n- a\n- b');
    expect(withText(written, editableText(written))).toBe(written);
    const edited = withText(written, 'Why\n\n- a');
    expect(edited.body).toBe('Why\n\n- a');
    expect(edited).not.toHaveProperty('points');
  });
});
