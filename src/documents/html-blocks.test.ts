import { describe, expect, it, vi } from 'vitest';

// DOMPurify needs a DOM; sanitization itself is its job, not this module's.
vi.mock('dompurify', () => ({ default: { sanitize: (html: string) => html } }));

import { renderHtmlBlocks, scopePageCss } from './html-blocks';
import { sectionRange } from './markdown-blocks';

const page = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '  <title>Spec</title>',
  '  <style>body { color: #222 }</style>',
  '</head>',
  '<body>',
  '  <h1>Spec</h1>',
  '  <p>First paragraph',
  '  continues here.</p>',
  '  <!-- a comment -->',
  '  <h2 id="goals">Goals</h2>',
  '  <ul>',
  '    <li>one</li>',
  '    <li>two</li>',
  '  </ul>',
  '  Stray text',
  '  <script>alert(1)</script>',
  '  <style>h2 { color: red }</style>',
  '</body>',
  '</html>',
].join('\n');

describe('renderHtmlBlocks', () => {
  it('makes one block per block-level element with its source lines', () => {
    const { blocks } = renderHtmlBlocks(page);
    expect(blocks.map((b) => [b.type, b.startLine, b.endLine])).toEqual([
      ['h1', 8, 8],
      ['p', 9, 10],
      ['h2', 12, 12],
      ['ul', 13, 16],
      ['text', 17, 17],
    ]);
    expect(blocks[1].raw).toBe('<p>First paragraph\n  continues here.</p>');
    expect(blocks[4].html).toBe('Stray text');
    expect(blocks.map((b) => b.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps headings selectable as sections', () => {
    const { blocks } = renderHtmlBlocks(page);
    expect(blocks[0]).toMatchObject({ headingLevel: 1, headingText: 'Spec' });
    expect(blocks[2]).toMatchObject({ headingLevel: 2, headingText: 'Goals' });
    expect(sectionRange(blocks, 2)).toEqual([2, 4]);
  });

  it('collects every stylesheet in document order and never renders scripts', () => {
    const { stylesheet, blocks, html } = renderHtmlBlocks(page);
    expect(stylesheet).toBe('body { color: #222 }\nh2 { color: red }');
    expect(blocks.some((b) => b.type === 'script' || b.type === 'style')).toBe(false);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<style');
  });

  it('marks every block in the page markup, wrapping bare text', () => {
    const { html } = renderHtmlBlocks(page);
    expect(html).toContain('<h1 data-block-index="0" class="doc-block">Spec</h1>');
    expect(html).toContain('<h2 id="goals" data-block-index="2" class="doc-block">Goals</h2>');
    expect(html).toContain(
      '<span data-block-index="4" class="doc-block">\n  Stray text\n  </span>',
    );
  });

  it('looks through wrappers to the innermost blocks and keeps the wrappers', () => {
    const { blocks, html } = renderHtmlBlocks(
      [
        '<!doctype html>',
        '<body>',
        '<main>',
        '  <h1>T</h1>',
        '  <section class="s"><h2>A</h2><p>x</p></section>',
        '  <div class="row"><span>inline only</span></div>',
        '  <blockquote><p>quoted</p></blockquote>',
        '</main>',
        '</body>',
      ].join('\n'),
    );
    expect(blocks.map((b) => [b.type, b.startLine])).toEqual([
      ['h1', 4],
      ['h2', 5],
      ['p', 5],
      ['div', 6],
      ['p', 7],
    ]);
    expect(html).toContain('<main>');
    expect(html).toContain('<section class="s"><h2 data-block-index="1" class="doc-block">');
    expect(html).toContain('<div class="row doc-block" data-block-index="3">');
    expect(html).toContain('<blockquote><p data-block-index="4" class="doc-block">');
  });

  it('ends an unclosed paragraph where the next block starts', () => {
    const { blocks } = renderHtmlBlocks('<!doctype html>\n<p>open\n<div>next</div>\n');
    expect(blocks.map((b) => [b.type, b.startLine, b.endLine, b.raw])).toEqual([
      ['p', 2, 2, '<p>open'],
      ['div', 3, 3, '<div>next</div>'],
    ]);
  });

  it('renders a page without a body as no blocks', () => {
    expect(renderHtmlBlocks('<!doctype html><html><head></head></html>').blocks).toEqual([]);
  });
});

describe('scopePageCss', () => {
  it('wraps the rules in @scope for the given root', () => {
    const css = scopePageCss('h1 { color: red }', '[data-page="main"]');
    expect(css).toContain(
      '@scope ([data-page="main"]) to (.docws-marker-anchor, .docws-section-btn, .docws-block-actions) {',
    );
    expect(css.indexOf(':where(:scope, :scope *) { margin: revert;')).toBeLessThan(
      css.indexOf('h1 {'),
    );
    expect(css).toContain('h1 { color: red }');
  });

  it('points html, :root and body rules at the scope root and leaves look-alikes alone', () => {
    const css = scopePageCss(
      'html, body { margin: 0 }\n:root { --brand: red }\nbody.dark > p { x: y }\n.body { a: b }\ntbody { c: d }\n@media print { body { e: f } }',
      '.r',
    );
    expect(css).toContain(':scope, :scope { margin: 0 }');
    expect(css).toContain(':scope { --brand: red }');
    expect(css).toContain(':scope.dark > p { x: y }');
    expect(css).toContain('.body { a: b }');
    expect(css).toContain('tbody { c: d }');
    expect(css).toContain('@media print { :scope { e: f } }');
  });

  it('gives universal selectors a :scope twin so a page reset reaches its body', () => {
    const css = scopePageCss('*, *::before { margin: 0 }\n* p { a: b }\n.c * { d: e }', '.r');
    expect(css).toContain('*, *::before, :scope, :scope::before { margin: 0 }');
    // Only a selector that is nothing but `*` can mean the root element.
    expect(css).toContain('* p { a: b }');
    expect(css).toContain('.c * { d: e }');
  });

  it('resolves rem against the root size the page set, and leaves other pages alone', () => {
    const moved = scopePageCss(
      ':root { font-size: 62.5% }\nh1 { font-size: 3.2rem; margin: 1rem }',
      '.r',
    );
    expect(moved).toContain('h1 { font-size: 32px; margin: 10px }');
    const untouched = scopePageCss('h1 { font-size: 3.2rem }', '.r');
    expect(untouched).toContain('h1 { font-size: 3.2rem }');
    // A page whose root sits at the browser default needs no rewriting either.
    const default16 = scopePageCss('html { font-size: 16px }\nh1 { font-size: 2rem }', '.r');
    expect(default16).toContain('h1 { font-size: 2rem }');
  });

  it('keeps a stray closing brace from ending the scope and going global', () => {
    const css = scopePageCss('p { a: b }\n} .docws-marker-anchor { display: none }', '.r');
    // One `{` for the wrapper, one for the browser defaults, one per page rule:
    // as many closers as openers means nothing escaped to the app.
    expect((css.match(/{/g) ?? []).length).toBe((css.match(/}/g) ?? []).length);
    expect(css.trimEnd().endsWith('}')).toBe(true);
    expect(css).not.toContain('}\n} .docws-marker-anchor');
  });

  it('closes what the page left open instead of letting it swallow the wrapper', () => {
    const css = scopePageCss('p { a: b', '.r');
    expect((css.match(/{/g) ?? []).length).toBe((css.match(/}/g) ?? []).length);
  });

  it('hoists font faces and keyframes out of the scope and drops imports', () => {
    const css = scopePageCss(
      '@import url(remote.css);\n@font-face { font-family: F; src: url(f.woff) }\np { a: b }\n@keyframes spin { to { transform: rotate(1turn) } }',
      '.r',
    );
    const scopeAt = css.indexOf('@scope');
    expect(css.indexOf('@font-face')).toBeLessThan(scopeAt);
    expect(css.indexOf('@keyframes spin')).toBeLessThan(scopeAt);
    expect(css.indexOf('p { a: b }')).toBeGreaterThan(scopeAt);
    expect(css).not.toContain('@import');
  });
});
