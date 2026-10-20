import { describe, expect, it } from 'vitest';
import {
  appendChildren,
  belowNodeId,
  countNodes,
  createNodeIds,
  findNode,
  nextNodeId,
  nodeTrail,
  nodesFromCards,
  pointQuestion,
  previousNodeId,
  questionPoint,
  rootIndexOf,
  type TourNode,
} from './tour-tree';
import type { TourCard } from './understanding-tour';

function card(title: string): TourCard {
  return { label: 'L', title, body: '', tone: 'neutral', refs: [] };
}

function node(id: string, children: TourNode[] = []): TourNode {
  return { id, card: card(id), children };
}

// gist, a (a1 (a1x), a2), b
const tree = [node('gist'), node('a', [node('a1', [node('a1x')]), node('a2')]), node('b')];

describe('tour tree', () => {
  it('reads the trail, the node and its root', () => {
    expect(nodeTrail(tree, 'a1x').map((entry) => entry.id)).toEqual(['a', 'a1', 'a1x']);
    expect(nodeTrail(tree, 'nope')).toEqual([]);
    expect(findNode(tree, 'a2')?.id).toBe('a2');
    expect(rootIndexOf(tree, 'a1x')).toBe(1);
    expect(rootIndexOf(tree, 'nope')).toBe(-1);
    expect(countNodes(tree)).toBe(6);
  });

  it('steps forward at one level and climbs out after the last child', () => {
    expect(nextNodeId(tree, 'gist')).toBe('a');
    // Children are entered on purpose, never by stepping forward.
    expect(nextNodeId(tree, 'a')).toBe('b');
    expect(nextNodeId(tree, 'a1')).toBe('a2');
    expect(nextNodeId(tree, 'a1x')).toBe('a2');
    expect(nextNodeId(tree, 'a2')).toBe('b');
    expect(nextNodeId(tree, 'b')).toBeUndefined();
  });

  it('steps down through the answers under one tour card and stops after them', () => {
    expect(belowNodeId(tree, 'a')).toBe('a1');
    expect(belowNodeId(tree, 'a1')).toBe('a1x');
    expect(belowNodeId(tree, 'a1x')).toBe('a2');
    expect(belowNodeId(tree, 'a2')).toBeUndefined();
    expect(belowNodeId(tree, 'gist')).toBeUndefined();
    expect(belowNodeId(tree, 'nope')).toBeUndefined();
  });

  it('steps back at one level and out to the parent from a first child', () => {
    expect(previousNodeId(tree, 'b')).toBe('a');
    expect(previousNodeId(tree, 'a2')).toBe('a1');
    expect(previousNodeId(tree, 'a1')).toBe('a');
    expect(previousNodeId(tree, 'a1x')).toBe('a1');
    expect(previousNodeId(tree, 'gist')).toBeUndefined();
  });

  it('appends answers under one node and keeps every other node as it was', () => {
    const added = [node('new')];
    const next = appendChildren(tree, 'a1', added);
    expect(findNode(next, 'a1')?.children.map((child) => child.id)).toEqual(['a1x', 'new']);
    expect(next[0]).toBe(tree[0]);
    expect(next[2]).toBe(tree[2]);
    expect(findNode(next, 'a2')).toBe(findNode(tree, 'a2'));
    expect(findNode(tree, 'a1')?.children).toHaveLength(1);
    expect(appendChildren(tree, 'nope', added)).toBe(tree);
  });

  it('hands out ids the tree does not use yet', () => {
    const nextId = createNodeIds([node('c4', [node('c9')]), node('x')]);
    expect(nextId()).toBe('c10');
    expect(nextId()).toBe('c11');
    const roots = nodesFromCards([card('one'), card('two')], createNodeIds(), 'Why?');
    expect(roots.map((entry) => [entry.id, entry.question])).toEqual([
      ['c1', 'Why?'],
      ['c2', 'Why?'],
    ]);
    expect(nodesFromCards([card('one')], createNodeIds())[0]).not.toHaveProperty('question');
  });

  it('round-trips the point a question digs into', () => {
    expect(questionPoint(pointQuestion('One branch per task'))).toBe('One branch per task');
    expect(questionPoint('Why?')).toBeUndefined();
    expect(questionPoint(undefined)).toBeUndefined();
  });
});
