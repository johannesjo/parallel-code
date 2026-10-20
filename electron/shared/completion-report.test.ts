import { describe, expect, it } from 'vitest';
import {
  parseCompletionRecord,
  parseSignalDoneInput,
  COMPLETION_REPORT_LIMITS as limits,
} from './completion-report.js';

const report = {
  summary: 'Implemented completion reports',
  verification: { checks: [{ name: 'Unit tests', command: 'npm test', result: 'passed' }] },
  artifacts: [{ path: 'reports/checks.txt', label: 'Test results' }],
  unresolvedIssues: ['Native smoke test not run'],
};
const completion = {
  id: 'c945dffc-ed36-4aa5-bb5b-179ce9d06897',
  completedAt: '2026-09-26T20:00:00.000Z',
  reviewRevision: 1,
  sourceCommit: 'a'.repeat(40),
  snapshotState: 'dirty',
  result: report,
};

describe('completion report validation', () => {
  it('accepts legacy calls and copies a bounded report without manufacturing evidence', () => {
    expect(parseSignalDoneInput({})).toEqual({});
    expect(parseSignalDoneInput(undefined)).toEqual({});
    const parsed = parseSignalDoneInput({ result: report });
    expect(parsed).toEqual({ result: report });
    expect(parsed.result?.verification?.checks).not.toBe(report.verification.checks);
    expect(parseSignalDoneInput({ result: { summary: 'Done' } })).toEqual({
      result: { summary: 'Done' },
    });
  });

  it.each([
    null,
    [],
    'done',
    { summary: 'not inside result' },
    { result: null },
    { result: {} },
    { result: { summary: ' ' } },
    { result: { summary: 'Done', verification: [] } },
    {
      result: {
        summary: 'Done',
        verification: { checks: [{ name: 'test', command: 'npm test', result: ['passed'] }] },
      },
    },
    { result: { summary: 'Done', artifacts: [{ path: 'ok', execute: true }] } },
    { result: { summary: 'Done', unresolvedIssues: [false] } },
    { result: { summary: 'Done', fakeChecks: true } },
  ])('rejects malformed input %j', (value) => {
    expect(() => parseSignalDoneInput(value)).toThrow();
  });

  it.each([
    '/etc/passwd',
    '../secret',
    'docs/../secret',
    './report',
    'a//b',
    'a/',
    'C:/file',
    'https://example.com',
    '\\server\\file',
    'a\u0000b',
  ])('rejects unsafe artifact path %s', (path) => {
    expect(() =>
      parseSignalDoneInput({ result: { summary: 'Done', artifacts: [{ path }] } }),
    ).toThrow('repository-relative');
  });

  it('enforces UTF-8 byte, item and aggregate bounds', () => {
    const parse = (result: unknown) => () => parseSignalDoneInput({ result });
    expect(parse({ summary: 'é'.repeat(limits.summaryBytes / 2) })).not.toThrow();
    expect(parse({ summary: 'é'.repeat(limits.summaryBytes / 2 + 1) })).toThrow('bytes');
    expect(
      parse({
        summary: 'Done',
        verification: { checks: Array.from({ length: 21 }, () => report.verification.checks[0]) },
      }),
    ).toThrow('20');
    expect(
      parse({ summary: 'Done', artifacts: Array.from({ length: 21 }, () => ({ path: 'a' })) }),
    ).toThrow('20');
    expect(parse({ summary: 'Done', unresolvedIssues: Array(11).fill('Issue') })).toThrow('10');
    expect(parse({ summary: 'Done', artifacts: [{ path: 'a'.repeat(1025) }] })).toThrow('bytes');
    expect(parse({ summary: 'Done', unresolvedIssues: ['a'.repeat(1025)] })).toThrow('bytes');
    expect(
      parse({
        summary: 'Done',
        artifacts: Array.from({ length: 20 }, () => ({ path: 'a'.repeat(900) })),
      }),
    ).toThrow('16384');
  });

  it('restores only valid complete records and tolerates old saves', () => {
    expect(parseCompletionRecord(completion)).toEqual(completion);
    expect(
      parseCompletionRecord({
        ...completion,
        sourceCommit: undefined,
        snapshotState: 'unknown',
        result: undefined,
      }),
    ).toMatchObject({ snapshotState: 'unknown' });
    for (const value of [
      undefined,
      null,
      {},
      { ...completion, id: 'bad' },
      { ...completion, completedAt: 'yesterday' },
      { ...completion, reviewRevision: -1 },
      { ...completion, sourceCommit: undefined },
      { ...completion, result: { summary: '' } },
    ]) {
      expect(parseCompletionRecord(value)).toBeUndefined();
    }
  });
});
