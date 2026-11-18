import { describe, expect, it } from 'vitest';
import { bookmarkLabel, bookmarkUrl, draftBookmark, sanitizeBookmarks } from './bookmarks';

describe('sanitizeBookmarks', () => {
  it('keeps plain and named bookmarks, trimming names and links', () => {
    expect(
      sanitizeBookmarks([
        { id: 'a', command: 'npm test' },
        { id: 'b', command: 'npm run dev', name: ' web ', url: ' localhost:4000 ' },
      ]),
    ).toEqual([
      { id: 'a', command: 'npm test' },
      { id: 'b', command: 'npm run dev', name: 'web', url: 'localhost:4000' },
    ]);
  });

  it('clears a bad name or link but keeps the bookmark', () => {
    expect(
      sanitizeBookmarks([{ id: 'a', command: 'npm start', name: 'x'.repeat(41), url: 7 }]),
    ).toEqual([{ id: 'a', command: 'npm start' }]);
  });

  it('drops entries without an id or command', () => {
    expect(
      sanitizeBookmarks([null, 'npm start', { command: 'x' }, { id: 'b', command: ' ' }]),
    ).toEqual([]);
    expect(sanitizeBookmarks('npm start')).toBeUndefined();
  });
});

describe('bookmarkLabel', () => {
  it('prefers the name and otherwise takes a word from the command', () => {
    expect(bookmarkLabel({ name: 'web', command: 'npm run dev' })).toBe('web');
    expect(bookmarkLabel({ command: 'npm run typecheck' })).toBe('typecheck');
  });
});

describe('bookmarkUrl', () => {
  it('fills in the task port and adds a scheme to a bare host', () => {
    expect(bookmarkUrl({ url: 'localhost:$PARALLEL_CODE_PORT' }, 20030)).toBe(
      'http://localhost:20030',
    );
    expect(bookmarkUrl({ url: 'https://127.0.0.1:${PARALLEL_CODE_PORT}/x' }, 20030)).toBe(
      'https://127.0.0.1:20030/x',
    );
  });

  it('has no address for a bookmark without a link', () => {
    expect(bookmarkUrl({}, 20030)).toBeUndefined();
  });
});

describe('draftBookmark', () => {
  it('trims the drafts and leaves blank optional fields out', () => {
    expect(draftBookmark({ command: ' npm test ', name: ' ', url: '' })).toEqual({
      id: expect.any(String),
      command: 'npm test',
    });
    expect(
      draftBookmark({ command: 'npm run dev', name: ' web ', url: ' localhost:3000 ' }),
    ).toEqual({
      id: expect.any(String),
      command: 'npm run dev',
      name: 'web',
      url: 'localhost:3000',
    });
  });

  it('makes nothing from a blank command', () => {
    expect(draftBookmark({ command: '  ', name: 'web', url: '' })).toBeUndefined();
  });
});
