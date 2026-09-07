import { describe, expect, it } from 'vitest';
import { isHtmlDocument } from './html-document';

describe('isHtmlDocument', () => {
  it('recognises a page by its doctype', () => {
    expect(isHtmlDocument('<!DOCTYPE html>\n<html lang="en">\n<head></head>\n')).toBe(true);
  });

  it('recognises a page that opens with <html>', () => {
    expect(isHtmlDocument('<html>\n<body>hi</body>\n</html>')).toBe(true);
    expect(isHtmlDocument('<html lang="en">')).toBe(true);
  });

  it('looks past leading comments and whitespace', () => {
    expect(isHtmlDocument('\n<!-- generated -->\n<!DOCTYPE html>\n<html>')).toBe(true);
  });

  it('leaves markdown with embedded HTML on the block view', () => {
    expect(isHtmlDocument('# Title\n\n<div class="callout">note</div>\n')).toBe(false);
    expect(isHtmlDocument('<div>just a fragment</div>')).toBe(false);
    expect(isHtmlDocument('Prose about <html> tags.')).toBe(false);
  });

  it('handles empty and missing content', () => {
    expect(isHtmlDocument('')).toBe(false);
    expect(isHtmlDocument(null)).toBe(false);
    expect(isHtmlDocument(undefined)).toBe(false);
  });
});
