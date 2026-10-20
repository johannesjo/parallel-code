import { isTourFilePath } from './tour-file';

const DOCUMENT_RE = /\.(md|markdown|html?)$/i;

/** A file the document workspace can edit: Markdown or HTML, but not a tour, which is generated. */
export function isEditableDocumentPath(path: string): boolean {
  return DOCUMENT_RE.test(path) && !isTourFilePath(path);
}
