import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, './documents.css'), 'utf8');

/** The declarations of one top-level rule, by its exact selector. */
function rule(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

/* The annotation popover opens on hover, so the path from the marker to the
   panel is part of its behaviour: these guard the two rules that make the
   panel reachable with a mouse at all. */
describe('annotation popover styles', () => {
  it('floats the popover over the window, placed by the marker with nothing to cross', () => {
    const pop = rule('.docws-marker-pop');

    // Fixed, so a page element clipping its overflow cannot trap it; the
    // marker sets top and right from the symbol's on-screen position.
    expect(pop).toMatch(/position:\s*fixed/);
    expect(pop).toMatch(/z-index:\s*var\(--docws-floating-z\)/);
    expect(pop).not.toMatch(/top:/);
    expect(pop).not.toMatch(/margin-top:/);
  });

  it('holds the popover open briefly after the pointer leaves, but not long', () => {
    const pop = rule('.docws-marker-pop');

    // The grace lets a pointer that cuts the corner get back in; while it runs
    // the panel is still a hit target over the prose, so it stays short.
    const grace = pop.match(/visibility 0s linear (\d*\.?\d+)s/);
    expect(grace, 'popover has no delayed visibility').not.toBeNull();
    expect(Number(grace?.[1])).toBeGreaterThan(0);
    expect(Number(grace?.[1])).toBeLessThanOrEqual(0.25);
  });

  it('lets the timestamp give way so the buttons beside it keep their row', () => {
    const time = rule('.docws-bubble-time');

    expect(time).toMatch(/min-width:\s*0/);
    expect(time).toMatch(/text-overflow:\s*ellipsis/);
  });
});

/* The viewer carries the app's dialog prose classes, and that style has a
   width cap of its own. Full width is the column's choice, so the cap must
   not come back through the prose. */
describe('document width', () => {
  it('lets the prose fill the column, which alone sets the reading measure', () => {
    expect(rule('.docws-doc')).toMatch(/max-width:\s*800px/);
    expect(rule('.docws-doc.is-full-width')).toMatch(/max-width:\s*none/);
    expect(rule('.docws-doc .docws-content')).toMatch(/max-width:\s*none/);
  });
});

describe('rail and toolbar layout', () => {
  it('keeps the view tabs at the left of the toolbar', () => {
    expect(rule('.docws-tabs')).toMatch(/margin-left:\s*auto/);
    expect(rule('.docws-toolbar .docws-tabs')).toMatch(/margin-left:\s*0/);
  });

  it('hides the agent tab instead of unmounting it', () => {
    expect(rule('.docws-agent-tab.is-hidden')).toMatch(/display:\s*none/);
  });
});

/* The workspace replaces the task columns in the same slot, so it has to sit
   on the same margins and carry the same rounded frame they do. */
describe('workspace frame', () => {
  it('insets the workspace by the task strip padding and rounds it like a column', () => {
    const ws = rule('.docws-workspace');

    expect(ws).toMatch(/inset:\s*2px 6px 2px 4px/);
    expect(ws).toMatch(/border-radius:\s*var\(--radius-lg\)/);
    expect(ws).toMatch(/border:\s*1px solid var\(--border\)/);
  });
});
