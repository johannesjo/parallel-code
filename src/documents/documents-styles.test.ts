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
  it('hangs the popover straight off the marker, with nothing to cross', () => {
    const pop = rule('.docws-marker-pop');

    expect(pop).toMatch(/top:\s*100%/);
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
