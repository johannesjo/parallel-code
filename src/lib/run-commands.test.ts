import { describe, expect, it } from 'vitest';
import { runCommandUrl, sanitizeRunCommands } from './run-commands';

describe('sanitizeRunCommands', () => {
  it('keeps valid entries, trims names and drops blank links', () => {
    expect(
      sanitizeRunCommands([
        { id: 'a', name: ' web ', command: 'npm run dev', url: '  ' },
        { id: 'b', name: 'api', command: 'npm run api', url: 'localhost:4000' },
      ]),
    ).toEqual([
      { id: 'a', name: 'web', command: 'npm run dev' },
      { id: 'b', name: 'api', command: 'npm run api', url: 'localhost:4000' },
    ]);
  });

  it('drops malformed entries and returns unset when none remain', () => {
    expect(sanitizeRunCommands([{ id: 'a', name: 'x'.repeat(41), command: 'npm start' }])).toBe(
      undefined,
    );
    expect(sanitizeRunCommands([null, 'npm start', { name: 'web', command: 'x' }])).toBe(undefined);
    expect(sanitizeRunCommands('npm start')).toBeUndefined();
  });
});

describe('runCommandUrl', () => {
  const run = { id: 'a', name: 'web', command: 'npm run dev' };

  it('fills in the task port and adds a scheme to a bare host', () => {
    expect(runCommandUrl({ ...run, url: 'localhost:$PARALLEL_CODE_PORT' }, 20030)).toBe(
      'http://localhost:20030',
    );
    expect(runCommandUrl({ ...run, url: 'https://127.0.0.1:${PARALLEL_CODE_PORT}/x' }, 20030)).toBe(
      'https://127.0.0.1:20030/x',
    );
  });

  it('has no address for a run without a link', () => {
    expect(runCommandUrl(run, 20030)).toBeUndefined();
  });
});
