import { describe, expect, it } from 'vitest';
import { pickerSections } from './CanvasFilePicker';

const all = ['README.md', 'docs/a.md', 'docs/b.md'];

describe('pickerSections', () => {
  it('lists changed files first and keeps them out of the rest', () => {
    expect(pickerSections(all, ['docs/b.md'], '')).toEqual([
      { title: 'Changed in this task', files: ['docs/b.md'] },
      { title: 'All Markdown files', files: ['README.md', 'docs/a.md'] },
    ]);
  });

  it('filters both sections and drops empty ones', () => {
    expect(pickerSections(all, ['docs/b.md'], 'docs/a')).toEqual([
      { title: 'All Markdown files', files: ['docs/a.md'] },
    ]);
    expect(pickerSections(all, [], 'zzz')).toEqual([]);
  });
});
