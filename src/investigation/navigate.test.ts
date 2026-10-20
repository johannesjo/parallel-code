import { expect, it } from 'vitest';
import { branchSnapshot, searchRecords } from './navigate';

const records = [
  { id: 'root', title: 'Why duplicates?', detail: '' },
  { id: 'a', parent: 'root', title: 'Retry path', detail: 'Two rows appeared with retry enabled.' },
  { id: 'a1', parent: 'a', title: 'Repeat the retry', detail: '' },
  { id: 'b', parent: 'root', title: 'Storage', detail: 'retry is unrelated here' },
];
const relations = [
  { id: 'r1', source: 'a1', target: 'a', kind: 'supports' },
  { id: 'r2', source: 'b', target: 'a', kind: 'challenges' },
];

it('cuts a branch out as its own map and keeps only links inside it', () => {
  const branch = branchSnapshot({ records, relations }, 'a');
  expect(branch.records.map((node) => node.id)).toEqual(['a', 'a1']);
  expect(branch.records[0].parent).toBeUndefined();
  expect(branch.relations.map((link) => link.id)).toEqual(['r1']);
  // An unknown root leaves the map untouched rather than blanking the stage.
  expect(branchSnapshot({ records, relations }, 'gone')).toEqual({ records, relations });
});

it('finds notes by title before notes by text, case-insensitively and bounded', () => {
  expect(searchRecords(records, 'RETRY').map((node) => node.id)).toEqual(['a', 'a1', 'b']);
  expect(searchRecords(records, 'two rows').map((node) => node.id)).toEqual(['a']);
  expect(searchRecords(records, '  ')).toEqual([]);
  expect(searchRecords(records, 'r', 2)).toHaveLength(2);
});
