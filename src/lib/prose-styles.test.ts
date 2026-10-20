import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');

/** The declarations of one top-level rule, by its exact selector. */
function rule(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

/* Rendered markdown shares one column with the rest of the app. Anything in it
   that is sized by its content — a wide table, a long URL — used to widen that
   column and leave the whole document scrolling sideways, so these rules are
   what keeps a document responsive.

   shortcut: asserts the declarations, not the layout they produce — happy-dom
   has no layout engine. A cascade or margin-collapsing regression gets past
   this; check it in a browser. */
describe('markdown prose overflow', () => {
  it('breaks long words instead of widening the column', () => {
    expect(rule('.plan-markdown')).toMatch(/overflow-wrap:\s*break-word/);
  });

  it('gives a wide table its own scrollbar', () => {
    const scroll = rule('.plan-markdown .md-table-scroll');
    expect(scroll).toMatch(/overflow-x:\s*auto/);
    expect(scroll).toMatch(/max-width:\s*100%/);
  });

  it('keeps code blocks scrolling inside their own box', () => {
    expect(rule('.plan-markdown pre')).toMatch(/overflow-x:\s*auto/);
    expect(rule('.plan-markdown pre.shiki-block')).toMatch(/overflow-x:\s*auto/);
  });
});
