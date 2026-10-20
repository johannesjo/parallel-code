import { Renderer, type Tokens } from 'marked';

/**
 * Wraps every rendered table in the scroll box the prose stylesheets style as
 * `.md-table-scroll`. A table is sized by its content, so a wide one otherwise
 * pushes past the prose column and leaves the whole document scrolling
 * sideways instead of scrolling by itself.
 *
 * Keep this the only `table` override on a renderer: marked replaces an
 * override rather than chaining it, so a second one drops the wrapper.
 */
export const tableScrollRenderer = {
  table(this: Renderer, token: Tokens.Table): string {
    return `<div class="md-table-scroll">${Renderer.prototype.table.call(this, token)}</div>`;
  },
};
