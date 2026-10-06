import { describe, expect, it } from 'vitest';
import {
  checkIdFor,
  effectiveChecks,
  parseEvidenceModelSettings,
  parseProjectChecks,
} from './evidence-settings.js';

describe('parseProjectChecks', () => {
  it('keeps valid checks and drops malformed, reserved and duplicate ones', () => {
    expect(
      parseProjectChecks([
        { id: 'unit', name: ' Unit ', kind: 'unit', command: ' npm test ', run: 'auto' },
        { id: 'unit', name: 'Dup', kind: 'unit', command: 'x', run: 'auto' },
        { id: 'verify', name: 'Clash', kind: 'unit', command: 'x', run: 'auto' },
        { id: 'e2e', name: 'E2E', kind: 'weird', command: 'npm run e2e', run: 'on-demand' },
        { id: 'blank', name: 'Blank', command: '  ' },
        'nope',
      ]),
    ).toEqual([
      { id: 'unit', name: 'Unit', kind: 'unit', command: 'npm test', run: 'auto' },
      { id: 'e2e', name: 'E2E', kind: 'custom', command: 'npm run e2e', run: 'on-demand' },
    ]);
  });

  it('returns undefined for a missing or empty list', () => {
    expect(parseProjectChecks(undefined)).toBeUndefined();
    expect(parseProjectChecks([{}])).toBeUndefined();
  });
});

describe('parseEvidenceModelSettings', () => {
  it('normalizes unknown values to safe defaults', () => {
    expect(parseEvidenceModelSettings({ when: 'always', provider: 'x', model: ' ' })).toEqual({
      when: 'off',
      provider: 'claude',
    });
    expect(
      parseEvidenceModelSettings({ when: 'risky', provider: 'codex', effort: 'high', model: 'm' }),
    ).toEqual({ when: 'risky', provider: 'codex', effort: 'high', model: 'm' });
    expect(parseEvidenceModelSettings(null)).toBeUndefined();
  });
});

describe('effectiveChecks', () => {
  it('puts the verify command first as an auto check', () => {
    const unit = {
      id: 'unit',
      name: 'Unit',
      kind: 'unit' as const,
      command: 't',
      run: 'auto' as const,
    };
    expect(effectiveChecks({ verifyCommand: ' npm run check ', evidenceChecks: [unit] })).toEqual([
      { id: 'verify', name: 'Verify', kind: 'custom', command: 'npm run check', run: 'auto' },
      unit,
    ]);
    expect(effectiveChecks({ verifyCommand: ' ' })).toEqual([]);
  });
});

describe('checkIdFor', () => {
  it('derives a unique slug and never reuses the verify id', () => {
    expect(checkIdFor('Unit tests', [])).toBe('unit-tests');
    expect(checkIdFor('Unit tests', ['unit-tests'])).toBe('unit-tests-2');
    expect(checkIdFor('Verify', [])).toBe('verify-2');
    expect(checkIdFor('!!!', [])).toBe('check');
  });
});
