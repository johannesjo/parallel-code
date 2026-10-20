import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, './documents.css'), 'utf8');
const appCss = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');

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
  it('contains authored stacking contexts below workspace controls in every viewer', () => {
    expect(rule('.docws-content')).toMatch(/isolation:\s*isolate/);
  });

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

describe('header drag region', () => {
  // The document actions share the draggable header, so a click on the
  // "N resolved" label must toggle it rather than start a window drag.
  it('carves labels out of the window drag region along with the controls', () => {
    expect(css).toMatch(/\.docws-header label,[^{]*\{[^}]*-webkit-app-region:\s*no-drag/);
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

/* The workspace fills a tile and carries the same rounded frame as coding tasks. */
describe('workspace frame', () => {
  it('fills its tile and rounds it like a task column', () => {
    const ws = rule('.docws-workspace');

    expect(ws).toMatch(/position:\s*relative/);
    expect(ws).toMatch(/height:\s*100%/);
    expect(ws).not.toMatch(/inset:/);
    expect(ws).toMatch(/border-radius:\s*var\(--radius-lg\)/);
    expect(ws).toMatch(/border:\s*1px solid var\(--border\)/);
  });
});

/* documents.css loads only with the lazy workspace panel. Without this rule the
   task strip's wrapper grows to its full content width, so <main> scrolls
   instead of the strip and focus mode renders off-screen. */
describe('task workspace styles', () => {
  it('keeps the task workspace rule in the eagerly loaded app stylesheet', () => {
    const start = appCss.indexOf('\n.task-workspace {');
    expect(start, 'no .task-workspace rule in styles.css').toBeGreaterThanOrEqual(0);
    expect(appCss.slice(start, appCss.indexOf('}', start))).toMatch(/min-width:\s*0/);
    expect(css).not.toContain('.task-workspace');
  });
});
