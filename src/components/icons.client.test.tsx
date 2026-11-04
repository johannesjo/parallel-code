import type { JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import * as icons from './icons';

type IconComponent = (props: { size?: number; title?: string }) => JSX.Element;

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
});

/** `EvidenceNoteIcon` draws its own 16x18 box at a 14px default and ignores
 *  `title`, and `AppLogo` is sized by CSS with no size/title props at all, so
 *  neither fits the standard square-icon assertions below. Both still get a
 *  render-smoke check at the bottom of this file. */
const NONSTANDARD_EXPORTS = new Set(['EvidenceNoteIcon', 'AppLogo']);

/** Every standard exported icon component, so the module stays render-covered. */
// Match by export key, not `fn.name`: CI's dev transform wraps components and
// renames them to `[solid-refresh]<Name>`, which slipped past the exemption.
const ALL_ICONS = Object.entries(icons)
  .filter(([name]) => !NONSTANDARD_EXPORTS.has(name))
  .map(([, icon]) => icon);

describe('shared icon module', () => {
  it('renders every icon at its default size of 16 and hides it from the a11y tree', () => {
    for (const Icon of ALL_ICONS) {
      const container = document.createElement('div');
      document.body.append(container);
      disposers.push(render(() => <Icon />, container));

      const svg = container.querySelector('svg');
      expect(svg, Icon.name).not.toBeNull();
      expect(svg?.getAttribute('width'), Icon.name).toBe('16');
      expect(svg?.getAttribute('height'), Icon.name).toBe('16');
      expect(svg?.getAttribute('aria-hidden'), Icon.name).toBe('true');
      expect(svg?.getAttribute('role'), Icon.name).toBeNull();
      expect(svg?.querySelector('title'), Icon.name).toBeNull();
    }
  });

  it('honors a custom size (12, the small size from issue #208)', () => {
    for (const Icon of ALL_ICONS) {
      const container = document.createElement('div');
      document.body.append(container);
      disposers.push(render(() => <Icon size={12} />, container));

      const svg = container.querySelector('svg');
      expect(svg?.getAttribute('width'), Icon.name).toBe('12');
      expect(svg?.getAttribute('height'), Icon.name).toBe('12');
    }
  });

  it('keeps the monochrome currentColor contract', () => {
    for (const Icon of ALL_ICONS) {
      const container = document.createElement('div');
      document.body.append(container);
      disposers.push(render(() => <Icon />, container));

      const svg = container.querySelector('svg');
      const fill = svg?.getAttribute('fill');
      expect(['currentColor', 'none'], Icon.name).toContain(fill);
      if (fill === 'none') {
        expect(svg?.getAttribute('stroke'), Icon.name).toBe('currentColor');
      }
    }
  });

  it('renders a title with role="img" when a title is provided', () => {
    for (const Icon of ALL_ICONS) {
      const container = document.createElement('div');
      document.body.append(container);
      disposers.push(render(() => <Icon title="Test label" />, container));

      const svg = container.querySelector('svg');
      expect(svg?.getAttribute('aria-hidden'), Icon.name).toBeNull();
      expect(svg?.getAttribute('role'), Icon.name).toBe('img');
      expect(svg?.querySelector('title')?.textContent, Icon.name).toBe('Test label');
    }
  });

  it('still renders the non-standard exports without throwing', () => {
    for (const name of NONSTANDARD_EXPORTS) {
      const Icon = (icons as unknown as Record<string, IconComponent>)[name];
      const container = document.createElement('div');
      document.body.append(container);
      disposers.push(render(() => <Icon />, container));
      expect(container.querySelector('svg'), name).not.toBeNull();
    }
  });
});
