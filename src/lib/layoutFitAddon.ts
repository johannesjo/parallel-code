import { FitAddon, type ITerminalDimensions } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

/**
 * Whether the terminal's container has a measurable computed size. A
 * container under `display: none`, or not in the document, reports `auto` or
 * an empty string instead of pixels.
 */
export function hasMeasurableContainer(term: Terminal): boolean {
  const parent = term.element?.parentElement;
  if (!parent) return false;
  const style = parent.ownerDocument.defaultView?.getComputedStyle(parent);
  if (!style) return false;
  return (
    Number.isFinite(parseInt(style.getPropertyValue('width'), 10)) &&
    Number.isFinite(parseInt(style.getPropertyValue('height'), 10))
  );
}

/**
 * FitAddon that proposes no size while the container cannot be measured.
 *
 * Up to 0.12.0-beta.195 the addon parsed `auto` as NaN and skipped the fit.
 * Later betas treat it as 0 px and shrink the terminal to its 2×1 minimum,
 * which reflows the scrollback and sends that size to the PTY. A pane mounted
 * or refitted inside a hidden container would start its agent at two columns.
 * `fit()` goes through `proposeDimensions()`, so this covers both.
 */
export class LayoutFitAddon extends FitAddon {
  private term: Terminal | undefined;

  override activate(terminal: Terminal): void {
    this.term = terminal;
    super.activate(terminal);
  }

  override proposeDimensions(): ITerminalDimensions | undefined {
    if (!this.term || !hasMeasurableContainer(this.term)) return undefined;
    return super.proposeDimensions();
  }
}
