import { describe, expect, it } from 'vitest';
import { cleanJobLog } from './job-log.js';

describe('cleanJobLog', () => {
  it('strips timestamps, colors and trailing blank lines', () => {
    const raw =
      '2026-10-05T14:31:14.1234567Z \x1b[31mError: boom\x1b[0m\r\n' +
      '2026-10-05T14:31:15.0000000Z ##[error]Process completed with exit code 1.\r\n\r\n';
    expect(cleanJobLog(raw)).toBe('Error: boom\n##[error]Process completed with exit code 1.');
  });

  it('ends at the last error marker, dropping post-job cleanup', () => {
    const raw = [
      '##[group]Run npm ci',
      'npm error code ERESOLVE',
      '##[error]Process completed with exit code 1.',
      'Post job cleanup.',
      'Cleaning up orphan processes',
    ].join('\n');
    expect(cleanJobLog(raw)).toBe(
      '##[group]Run npm ci\nnpm error code ERESOLVE\n##[error]Process completed with exit code 1.',
    );
  });

  it('keeps only the end of long logs, without a partial first line', () => {
    const raw = Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(80)}`).join('\n');
    const tail = cleanJobLog(raw);
    expect(tail.length).toBeLessThanOrEqual(4_000);
    expect(tail.split('\n')[0]).toMatch(/^line \d+ x+$/);
    expect(tail.endsWith(`line 499 ${'x'.repeat(80)}`)).toBe(true);
  });
});
