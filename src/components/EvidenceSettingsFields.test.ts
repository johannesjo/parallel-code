import { describe, expect, it } from 'vitest';
import { finalizeChecks } from './EvidenceSettingsFields';

describe('finalizeChecks', () => {
  it('names checks after their kind, keeps existing ids and drops rows without a command', () => {
    expect(
      finalizeChecks([
        { id: 'unit-tests', kind: 'unit', command: 'npm test', run: 'auto' },
        { kind: 'e2e', command: 'npm run e2e', run: 'on-demand' },
        { kind: 'unit', command: 'npm run test:client', run: 'auto' },
        { kind: 'static', command: ' ', run: 'auto' },
      ]),
    ).toEqual([
      { id: 'unit-tests', name: 'Unit tests', kind: 'unit', command: 'npm test', run: 'auto' },
      {
        id: 'e2e-tests',
        name: 'E2E tests',
        kind: 'e2e',
        command: 'npm run e2e',
        run: 'on-demand',
      },
      {
        id: 'unit-tests-2',
        name: 'Unit tests 2',
        kind: 'unit',
        command: 'npm run test:client',
        run: 'auto',
      },
    ]);
  });

  it('clears the setting when every row is blank', () => {
    expect(finalizeChecks([{ kind: 'unit', command: '', run: 'auto' }])).toBeUndefined();
  });
});
