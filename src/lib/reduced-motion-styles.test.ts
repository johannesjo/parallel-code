import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');

function reducedMotionBlock(): { block: string; end: number } {
  const marker = '@media (prefers-reduced-motion: reduce)';
  const start = css.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(css.lastIndexOf(marker)).toBe(start);

  const openingBrace = css.indexOf('{', start);
  let depth = 0;
  for (let index = openingBrace; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') depth -= 1;
    if (depth === 0) return { block: css.slice(start, index + 1), end: index };
  }

  throw new Error('Unclosed reduced-motion media query');
}

function expectRule(block: string, selectors: string[], declaration: RegExp): void {
  const selectorPattern = selectors
    .map((selector) => selector.replaceAll('.', '\\.'))
    .join('\\s*,\\s*');
  const rule = new RegExp(
    `${selectorPattern}\\s*\\{[^}]*${declaration.source}[^}]*\\}`,
    declaration.flags,
  );
  expect(block).toMatch(rule);
}

describe('main stylesheet reduced-motion styles', () => {
  it('pairs each main-app selector group with its reduced-motion override', () => {
    const { block, end } = reducedMotionBlock();

    expectRule(block, ['.projects-collapser'], /transition:\s*none\s*;/);
    expectRule(
      block,
      [
        '.task-appearing',
        '.task-item-appearing',
        '.task-removing',
        '.task-item-removing',
        '.status-dot-pulse',
      ],
      /animation:\s*none\s*;/,
    );
    expectRule(
      block,
      ['.askcode-loading-pulse', '.keybinding-key'],
      /animation:\s*none\s*!important\s*;/,
    );
    expect(block).not.toContain('.inline-spinner');
    expect(block).not.toContain('keybinding-recording-pulse');
    expect(
      css.slice(end + 1).trim(),
      'Keep the reduced-motion block at the end of styles.css so its class rules win by source order',
    ).toBe('');
  });
});
