import { expect, it } from 'vitest';
import { isEditableDocumentPath } from './document-path';

it('edits Markdown and HTML but not tours or other files', () => {
  expect(isEditableDocumentPath('docs/spec.md')).toBe(true);
  expect(isEditableDocumentPath('/site/index.HTML')).toBe(true);
  expect(isEditableDocumentPath('docs/intro.tour.md')).toBe(false);
  expect(isEditableDocumentPath('src/main.ts')).toBe(false);
});
