import { render } from 'solid-js/web';
import { afterEach, expect, it } from 'vitest';
import { KindMark } from './KindMark';

let dispose: (() => void) | undefined;
afterEach(() => dispose?.());

it('draws evidence as an outlined document instead of the solid text glyph', () => {
  const container = document.createElement('div');
  dispose = render(() => <KindMark kind="observation" mark="▤" size={11} />, container);
  const svg = container.querySelector('svg');
  expect(svg?.getAttribute('fill')).toBe('none');
  expect(svg?.getAttribute('stroke')).toBe('currentColor');
  expect(svg?.getAttribute('width')).toBe('11');
  expect(container.textContent).not.toContain('▤');
});

it('keeps the text glyph for other kinds', () => {
  const container = document.createElement('div');
  dispose = render(() => <KindMark kind="hypothesis" mark="◇" />, container);
  expect(container.querySelector('svg')).toBeNull();
  expect(container.textContent).toBe('◇');
});
