import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';

const window = new Window();
const style = window.document.createElement('style');
style.textContent = readFileSync(resolve(__dirname, 'styles.css'), 'utf8');
window.document.head.append(style);

function declarationsFor(selector: string): CSSStyleDeclaration {
  const rule = Array.from(style.sheet?.cssRules ?? []).find(
    (candidate) => 'selectorText' in candidate && candidate.selectorText === selector,
  ) as CSSStyleRule | undefined;

  if (!rule) throw new Error(`Missing CSS rule for ${selector}`);
  return rule.style;
}

describe('tiling layout horizontal scrollbar', () => {
  it('scopes a 10px hit target and 6px painted thumb to the tiling strip', () => {
    const strip = declarationsFor('.tiling-layout-strip');
    expect(strip.getPropertyValue('scrollbar-width')).toBe('auto');
    expect(strip.getPropertyValue('scrollbar-color')).toBe('auto');

    const scrollbar = declarationsFor('.tiling-layout-strip::-webkit-scrollbar');
    expect(scrollbar.getPropertyValue('height')).toBe('10px');

    const thumb = declarationsFor('.tiling-layout-strip::-webkit-scrollbar-thumb');
    expect(thumb.getPropertyValue('border-block')).toBe('2px solid transparent');
    expect(thumb.getPropertyValue('background-clip')).toBe('padding-box');

    const globalScrollbar = declarationsFor('::-webkit-scrollbar');
    expect(globalScrollbar.getPropertyValue('width')).toBe('5px');
    expect(globalScrollbar.getPropertyValue('height')).toBe('5px');
  });
});
