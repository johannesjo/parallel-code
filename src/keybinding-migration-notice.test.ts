import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const app = readFileSync(resolve(__dirname, 'App.tsx'), 'utf8');
const css = readFileSync(resolve(__dirname, 'styles.css'), 'utf8');

describe('keybinding migration notice', () => {
  it('stays outside the main layout flow', () => {
    const rule = css.match(/\.keybinding-migration-notice\s*\{([^}]*)\}/);

    expect(rule).not.toBeNull();
    expect(rule?.[1]).toMatch(/position:\s*fixed\s*;/);
    expect(rule?.[1]).toMatch(/width:\s*min\(560px,\s*calc\(100vw - 32px\)\)\s*;/);
    expect(app).toContain('class="keybinding-migration-notice"');
    const notice = app.indexOf('class="keybinding-migration-notice"');
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(app.search(/<main[\s>]/));
  });

  it('keeps the notice and dismiss control accessible', () => {
    expect(app).toContain('role="region"');
    expect(app).toContain('aria-label="Keyboard shortcuts update"');
    expect(app).toContain('aria-label="Dismiss keyboard shortcuts update"');
  });
});
