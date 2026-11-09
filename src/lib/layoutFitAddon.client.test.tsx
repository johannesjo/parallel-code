import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LayoutFitAddon } from './layoutFitAddon';

const terminals: Terminal[] = [];

beforeEach(() => {
  // happy-dom has no canvas; xterm's DOM renderer only measures glyph widths.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    font: '',
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    measureText: () => ({ width: 8 }),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('OffscreenCanvas', undefined);
  // happy-dom has no layout: give xterm a measurable 8×16 px character cell.
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(256);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(16);
});

afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function openTerminal(addon: FitAddon, containerStyle: string): Terminal {
  const container = document.createElement('div');
  container.style.cssText = containerStyle;
  document.body.append(container);
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  terminals.push(term);
  term.loadAddon(addon);
  term.open(container);
  return term;
}

it('keeps the size of a terminal whose container has no measurable size', () => {
  const addon = new LayoutFitAddon();
  const term = openTerminal(addon, 'display: none');
  expect(addon.proposeDimensions()).toBeUndefined();
  addon.fit();
  expect([term.cols, term.rows]).toEqual([80, 24]);
});

it('shows why the guard exists: the stock addon shrinks that terminal to 2 columns', () => {
  const addon = new FitAddon();
  const term = openTerminal(addon, 'display: none');
  addon.fit();
  expect(term.cols).toBe(2);
});

it('still fits a terminal whose container has a size', () => {
  const addon = new LayoutFitAddon();
  const term = openTerminal(addon, 'width: 400px; height: 160px');
  addon.fit();
  expect(term.cols).toBeLessThan(80);
  expect(term.cols).toBeGreaterThan(2);
  expect(term.rows).toBe(10);
});
