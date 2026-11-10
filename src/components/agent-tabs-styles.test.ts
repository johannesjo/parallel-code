import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');
const terminal = readFileSync(resolve(__dirname, 'TaskAITerminal.tsx'), 'utf8');

describe('agent header tab strip (#339)', () => {
  it('floors each tab wrapper above its content instead of letting it shrink inside', () => {
    // The floor must live on the wrapper span: with `min-width: 0` there the
    // outer flex could shrink the wrapper below its own children (44px label
    // floor + 20px close button), so tabs painted over each other.
    const wrapperRule = css.match(/\.agent-header-tabs > \*\s*\{([^}]*)\}/);
    expect(wrapperRule).not.toBeNull();
    expect(wrapperRule?.[1]).toMatch(/min-width:\s*64px/);
    expect(wrapperRule?.[1]).not.toMatch(/min-width:\s*0/);
  });

  it('makes the tab button absorb the remaining shrink with an ellipsized label', () => {
    const buttonRule = css.match(/\.agent-header-tabs \.agent-tab\s*\{([^}]*)\}/);
    expect(buttonRule).not.toBeNull();
    expect(buttonRule?.[1]).toMatch(/min-width:\s*0/);
    expect(buttonRule?.[1]).toMatch(/overflow:\s*hidden/);

    const labelRule = css.match(/\.agent-header-tabs \.agent-tab > span:first-child\s*\{([^}]*)\}/);
    expect(labelRule).not.toBeNull();
    expect(labelRule?.[1]).toMatch(/text-overflow:\s*ellipsis/);
    expect(labelRule?.[1]).toMatch(/white-space:\s*nowrap/);
  });

  it('keeps the agent number badge and close button out of the shrink', () => {
    const pinned = css.match(
      /\.agent-header-tabs button > span \+ span,\s*\n\.agent-header-tabs button \+ button\s*\{([^}]*)\}/,
    );
    expect(pinned).not.toBeNull();
    expect(pinned?.[1]).toMatch(/flex-shrink:\s*0/);
  });

  it('tags the selectable tab button with the agent-tab class the rules target', () => {
    // The tab button sits next to its close button (a `button + button`
    // sibling), so the structural selectors keep matching.
    expect(terminal).toMatch(/<button\s*type="button"\s*class="agent-tab"/);
    expect(terminal).toMatch(/title="Close AI agent"/);
  });
});
