import path from 'node:path';
import { describe, expect, it } from 'vitest';
import config, { RENDERER_CSP } from './vite.config.electron';

describe('electron vite config', () => {
  it('watches this checkout even when it is itself inside a worktree', () => {
    const ignored = config.server?.watch?.ignored;
    if (typeof ignored !== 'function') throw new Error('Expected a root-relative watch predicate');
    expect(ignored(process.cwd())).toBe(false);
    expect(ignored(path.join(process.cwd(), 'src/investigation/InvestigationGraph.tsx'))).toBe(
      false,
    );
  });
  it('ignores worktrees nested under this checkout', () => {
    const ignored = config.server?.watch?.ignored;
    if (typeof ignored !== 'function') throw new Error('Expected a root-relative watch predicate');
    expect(ignored(path.join(process.cwd(), '.worktrees/task/other/src/index.tsx'))).toBe(true);
  });
});

describe('renderer Content-Security-Policy', () => {
  it('restricts scripts to the bundle and forbids plugins, framing, and base overrides', () => {
    expect(RENDERER_CSP).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(RENDERER_CSP).toContain("object-src 'none'");
    expect(RENDERER_CSP).toContain("base-uri 'none'");
    expect(RENDERER_CSP).toContain("frame-src 'none'");
    expect(RENDERER_CSP).toContain("connect-src 'self';");
    expect(RENDERER_CSP).not.toContain("'unsafe-eval'");
    expect(RENDERER_CSP).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it('is injected into the built index.html, and only at build time', () => {
    const plugins = (config.plugins ?? []).flat() as Array<{
      name?: string;
      apply?: unknown;
      transformIndexHtml?: unknown;
    }>;
    const csp = plugins.find((p) => p?.name === 'parallel-code:renderer-csp');
    expect(csp).toBeDefined();
    expect(csp?.apply).toBe('build');
    const hook = csp?.transformIndexHtml as
      | (() => Array<{ tag: string; attrs: Record<string, string> }>)
      | undefined;
    const tags = hook?.();
    expect(tags).toEqual([
      expect.objectContaining({
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: RENDERER_CSP },
      }),
    ]);
  });
});
