import { describe, expect, it } from 'vitest';
import { planCardMotion } from './task-board-motion';

const at = (left: number, top: number) => ({ left, top });

describe('planCardMotion', () => {
  it('moves cards that changed place by the distance they travelled back', () => {
    const plan = planCardMotion(
      new Map([
        ['a', at(0, 0)],
        ['b', at(0, 100)],
      ]),
      new Map([
        ['a', at(240, 0)],
        ['b', at(0, 0)],
      ]),
    );
    expect(plan.moved).toEqual([
      { id: 'a', dx: -240, dy: 0 },
      { id: 'b', dx: 0, dy: 100 },
    ]);
    expect(plan.added).toEqual([]);
    expect(plan.removed).toEqual([]);
  });

  it('leaves cards that stayed, or shifted by under a pixel, alone', () => {
    const plan = planCardMotion(new Map([['a', at(10, 10)]]), new Map([['a', at(10.4, 9.6)]]));
    expect(plan.moved).toEqual([]);
  });

  it('reports cards that arrived and cards that left', () => {
    const plan = planCardMotion(
      new Map([
        ['gone', at(0, 0)],
        ['kept', at(0, 50)],
      ]),
      new Map([
        ['kept', at(0, 50)],
        ['new', at(0, 100)],
      ]),
    );
    expect(plan).toEqual({ moved: [], added: ['new'], removed: ['gone'] });
  });
});
