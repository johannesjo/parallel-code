import { describe, expect, it } from 'vitest';
import { buildSquashMessage, formatSquashMessage } from './squash-message';

describe('buildSquashMessage', () => {
  it('keeps a single commit as it is', () => {
    expect(buildSquashMessage([{ hash: 'a', message: 'fix: one', body: 'Why.' }], 'Task')).toEqual({
      title: 'fix: one',
      body: 'Why.',
    });
  });

  it('titles several commits with the fallback and lists them with their bodies', () => {
    expect(
      buildSquashMessage(
        [
          { hash: 'a', message: 'feat: a', body: 'Body A\n\nMore A' },
          { hash: 'b', message: 'fix: b', body: '' },
        ],
        'Task title',
      ),
    ).toEqual({ title: 'Task title', body: '* feat: a\n\nBody A\n\nMore A\n\n* fix: b' });
  });

  it('moves co-author trailers to the end, deduplicated', () => {
    const { body } = buildSquashMessage(
      [
        { hash: 'a', message: 'a', body: 'Text\n\nCo-Authored-By: Bot <b@x>' },
        { hash: 'b', message: 'b', body: 'co-authored-by: bot <B@X>\nCo-authored-by: Ann <a@x>' },
      ],
      'T',
    );
    expect(body).toBe('* a\n\nText\n\n* b\n\nCo-authored-by: Bot <b@x>\nCo-authored-by: Ann <a@x>');
  });
});

describe('formatSquashMessage', () => {
  it('separates title and body by a blank line and omits an empty body', () => {
    expect(formatSquashMessage({ title: 'T', body: 'B' })).toBe('T\n\nB');
    expect(formatSquashMessage({ title: ' T ', body: '  ' })).toBe('T');
  });
});
