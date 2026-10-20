import { describe, expect, it } from 'vitest';
import { MAX_TOUR_DEPTH, type TourNode } from './tour-tree';
import { TOUR_MAP_ROOT, mindMapToTour, tourToMindMap } from './tour-mindmap';
import type { TourCard } from './understanding-tour';

function card(title: string, over: Partial<TourCard> = {}): TourCard {
  return { label: 'L', title, body: '', tone: 'neutral', refs: [], ...over };
}

const tree: TourNode[] = [
  {
    id: 'c1',
    card: card('Sync breaks', { points: ['Clocks drift', 'Retries resend'] }),
    children: [{ id: 'c2', card: card('Clocks', { body: 'Use server time' }), children: [] }],
  },
  { id: 'c3', card: card('Fix'), children: [] },
];

describe('tour as a mind map', () => {
  it('puts the title at the centre and every card under it', () => {
    const map = tourToMindMap('Sync', tree);
    expect(map.records.map((record) => [record.id, record.parent])).toEqual([
      [TOUR_MAP_ROOT, undefined],
      ['c1', TOUR_MAP_ROOT],
      ['c2', 'c1'],
      ['c3', TOUR_MAP_ROOT],
    ]);
    expect(map.records[1].detail).toBe('- Clocks drift\n- Retries resend');
    expect(map.relations).toEqual([]);
  });

  it('reads back unchanged, keeping what the map does not show', () => {
    const back = mindMapToTour(tourToMindMap('Sync', tree), tree);
    expect(back).toEqual(tree);
  });

  it('takes the map edits: titles, text, moves and new ideas', () => {
    const map = tourToMindMap('Sync', tree);
    const [root, c1, c2, c3] = map.records;
    const edited = {
      ...map,
      records: [
        root,
        { ...c1, title: 'Sync really breaks' },
        { ...c3, detail: 'Now with text' },
        { ...c2, parent: 'c3' },
        { id: 'new', parent: 'c1', title: 'Idea', detail: '' },
      ],
    };
    const back = mindMapToTour(edited, tree);
    expect(back.map((node) => node.card.title)).toEqual(['Sync really breaks', 'Fix']);
    expect(back[0].card.points).toEqual(['Clocks drift', 'Retries resend']);
    expect(back[0].children.map((node) => node.id)).toEqual(['new']);
    expect(back[1].card.body).toBe('Now with text');
    expect(back[1].card.label).toBe('L');
    expect(back[1].children.map((node) => node.id)).toEqual(['c2']);
  });

  it('lifts ideas nested deeper than a tour can go', () => {
    const records = [{ id: TOUR_MAP_ROOT, title: 'T', detail: '' }];
    for (let level = 1; level <= MAX_TOUR_DEPTH + 1; level += 1)
      records.push({
        id: `d${level}`,
        parent: level === 1 ? TOUR_MAP_ROOT : `d${level - 1}`,
        title: `d${level}`,
        detail: '',
      } as (typeof records)[number]);
    let node = mindMapToTour({ version: 1, revision: 0, records, relations: [] }, [])[0];
    for (let level = 1; level < MAX_TOUR_DEPTH - 1; level += 1) node = node.children[0];
    expect(node.children.map((child) => child.id)).toEqual([
      `d${MAX_TOUR_DEPTH}`,
      `d${MAX_TOUR_DEPTH + 1}`,
    ]);
  });
});
