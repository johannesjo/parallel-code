import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import * as icons from './icons';

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
});

/** Every exported icon component, so the whole module stays render-covered. */
const ALL_ICONS = Object.values(icons);

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
});
