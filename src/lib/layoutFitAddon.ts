import { FitAddon, type ITerminalDimensions } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

/**
 * Whether the terminal's container is laid out and has a pixel size.
 *
 * Inside a `display: none` subtree Chromium reports the container's specified
 * width (`100%`, `400px`, `calc(...)`) rather than a measured one, so the
 * computed style alone cannot tell a hidden container from a visible one.
 * A box that is not rendered has no client rects; that check covers a hidden
 * ancestor and a detached element whatever the styles say. The computed-style
 * check catches `auto` and environments without layout.
 */
export function hasMeasurableContainer(term: Terminal): boolean {
  const parent = term.element?.parentElement;
  if (!parent?.isConnected || parent.getClientRects().length === 0) return false;
  const style = parent.ownerDocument.defaultView?.getComputedStyle(parent);
  if (!style) return false;
  return (
    Number.isFinite(parseInt(style.getPropertyValue('width'), 10)) &&
    Number.isFinite(parseInt(style.getPropertyValue('height'), 10))
  );
}

/**
 * FitAddon that proposes no size while the container is hidden.
 *
 * Up to 0.12.0-beta.195 the addon parsed a non-pixel width as NaN and skipped
 * the fit. Later betas treat it as 0 px and shrink the terminal to its 2×1
 * minimum, which reflows the scrollback and sends that size to the PTY: a
 * pane mounted or refitted while hidden would start its agent at two columns.
 * `fit()` goes through `proposeDimensions()`, so this covers both.
 */
export class LayoutFitAddon extends FitAddon {
  private term: Terminal | undefined;

  override activate(terminal: Terminal): void {
    this.term = terminal;
    super.activate(terminal);
  }

  override dispose(): void {
    this.term = undefined;
    super.dispose();
  }

  override proposeDimensions(): ITerminalDimensions | undefined {
    if (!this.term || !hasMeasurableContainer(this.term)) return undefined;
    return super.proposeDimensions();
  }
}
