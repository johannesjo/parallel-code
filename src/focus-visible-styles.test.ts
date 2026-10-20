import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, 'styles.css'), 'utf8');
const placeholder = readFileSync(resolve(__dirname, 'components/NewTaskPlaceholder.tsx'), 'utf8');

const globalFocusSelectors = [
  'button',
  'input',
  'select',
  'textarea',
  'a[href]',
  "[tabindex]:not([tabindex='-1'])",
  "[role='button']",
  "[role='switch']",
  "[role='checkbox']",
  "[role='link']",
  "[role='menuitem']",
  "[role='menuitemradio']",
  "[role='menuitemcheckbox']",
  "[role='tab']",
  "[role='option']",
  "[role='combobox']",
  "[role='radio']",
];

describe('global focus-visible styles', () => {
  it('uses a low-specificity app-wide default that components can override', () => {
    const rule = css.match(/(?:^|\n):where\(([\s\S]*?)\):focus-visible\s*\{([^}]*)\}/);

    expect(rule).not.toBeNull();
    expect(rule?.[1].split(',').map((selector) => selector.trim())).toEqual(globalFocusSelectors);
    expect(rule?.[2]).toMatch(/outline:\s*2px solid var\(--border-focus\)/);
    expect(css).not.toMatch(/(?:^|\n):is\([\s\S]*?\):focus-visible/);
  });

  it('uses the DOM focus indicator as the placeholder focus state', () => {
    expect(css).not.toMatch(/\.new-task-placeholder:focus-visible\s*\{[^}]*outline:\s*none/);
    expect(placeholder).not.toContain('store.placeholderFocused');
    expect(placeholder).not.toMatch(/focused(?:Border|Color|Bg)/);
  });
});
