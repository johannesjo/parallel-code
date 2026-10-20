import { describe, expect, it } from 'vitest';
import {
  normalizeBrowserUrl,
  parseBrowserBounds,
  parsePickedElement,
  formatElementReference,
} from './browser.js';

describe('browser boundaries', () => {
  it('accepts web URLs and shorthand local addresses', () => {
    expect(normalizeBrowserUrl(' localhost:5173/test ')).toBe('http://localhost:5173/test');
    expect(normalizeBrowserUrl('https://example.com')).toBe('https://example.com/');
    expect(normalizeBrowserUrl('127.0.0.1:3000')).toBe('http://127.0.0.1:3000/');
  });
  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hello',
    'https://user:pass@example.com',
    '',
    null,
  ])('rejects unsafe URL %s', (url) => {
    expect(() => normalizeBrowserUrl(url)).toThrow();
  });
  it('rejects malformed geometry instead of positioning a native view', () => {
    expect(parseBrowserBounds(null)).toBeNull();
    expect(parseBrowserBounds({ x: 10.4, y: 20, width: 300.6, height: 200 })).toEqual({
      x: 10,
      y: 20,
      width: 301,
      height: 200,
    });
    expect(() => parseBrowserBounds({ x: 0, y: 0, width: -1, height: Infinity })).toThrow();
  });
  it('bounds picker data and formats it as page context', () => {
    const element = parsePickedElement({
      selector: '#save',
      text: 'Save',
      html: '<button id="save">Save</button>',
    });
    const reference = formatElementReference('http://localhost:5173/', element);
    expect(reference).toContain('#save');
    expect(reference).toContain('http://localhost:5173/');
    expect(reference).toContain('page content');
    expect(() => parsePickedElement({ selector: 'x'.repeat(4097), text: '', html: '' })).toThrow();
    expect(() => parsePickedElement({ selector: {}, text: '', html: '' })).toThrow();
  });
});
