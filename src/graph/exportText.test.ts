import { expect, it } from 'vitest';
import { graphToJson, graphToMarkdown, graphToMermaid } from './exportText';
import type { GraphDocument } from '../../electron/shared/graph';

const document: GraphDocument = {
  version: 1,
  revision: 3,
  records: [
    { id: 'root', title: 'Topic', detail: 'Note one\n\nNote two' },
    { id: 'b', parent: 'root', title: 'Second', detail: '' },
    { id: 'a', parent: 'root', title: 'First', detail: '', kind: 'hypothesis', status: 'untested' },
    { id: 'a1', parent: 'a', title: 'Deep', detail: '' },
  ],
  relations: [{ id: 'l', source: 'a1', target: 'b', kind: 'supports', rationale: 'because' }],
  explanations: [{ id: 'q', nodeId: 'a', question: 'Why first?', answer: 'It came\nearlier.' }],
};

it('writes an indented outline in sibling order with notes, Q&A and links', () => {
  expect(graphToMarkdown(document, 'Map')).toBe(
    [
      '# Map',
      '',
      '- Topic',
      '  > Note one',
      '  > Note two',
      '  - Second',
      '  - [hypothesis · untested] First',
      '    > Q: Why first?',
      '    > A: It came',
      '    > earlier.',
      '    - Deep',
      '',
      '## Links',
      '',
      '- Deep → Second (supports): because',
      '',
    ].join('\n'),
  );
});

it('keeps multi-line titles on one outline bullet and one link line', () => {
  const tricky: GraphDocument = {
    version: 1,
    revision: 1,
    records: [
      { id: 'root', title: 'Topic', detail: '' },
      { id: 'x', parent: 'root', title: 'Real\n- Fake bullet', detail: '' },
      { id: 'y', parent: 'root', title: 'Other  \n\n  line', detail: '' },
    ],
    relations: [{ id: 'l', source: 'x', target: 'y' }],
  };
  expect(graphToMarkdown(tricky)).toBe(
    [
      '- Topic',
      '  - Real - Fake bullet',
      '  - Other line',
      '',
      '## Links',
      '',
      '- Real - Fake bullet → Other line',
      '',
    ].join('\n'),
  );
});

it('writes a Mermaid flowchart with positional ids, escaped labels and labelled links', () => {
  const quoted: GraphDocument = {
    ...document,
    records: [
      ...document.records,
      { id: 'weird id', parent: 'root', title: 'Say "hi"\n<b>#1</b>', detail: '' },
    ],
    relations: [
      ...document.relations,
      { id: 'c', source: 'weird id', target: 'a', kind: 'challenges' },
      { id: 'gone', source: 'a', target: 'missing' },
      { id: 'piped', source: 'a', target: 'b', kind: 'x| n1 --> n2' },
      { id: 'shapes', source: 'b', target: 'a1', kind: 'depends on (weak) [1] {b} "q"' },
    ],
  };
  expect(graphToMermaid(quoted, 'Map: "1"')).toBe(
    [
      '---',
      'title: "Map: \\"1\\""',
      '---',
      'flowchart TD',
      '  n1["Topic"]',
      '  n2["Second"]',
      '  n3["First<br/><i>hypothesis · untested</i>"]',
      '  n4["Deep"]',
      '  n5["Say #34;hi#34; #60;b#62;#35;1#60;/b#62;"]',
      '  n1 --> n2',
      '  n1 --> n3',
      '  n3 --> n4',
      '  n1 --> n5',
      '  n4 -->|"supports"| n2',
      '  n5 -.->|"challenges"| n3',
      '  n3 -->|"x#124; n1 --#62; n2"| n2',
      '  n2 -->|"depends on (weak) [1] {b} #34;q#34;"| n4',
      '',
    ].join('\n'),
  );
});

it('serialises the whole document as JSON', () => {
  expect(JSON.parse(graphToJson(document))).toEqual(document);
});
