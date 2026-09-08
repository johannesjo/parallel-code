import { describe, expect, it } from 'vitest';
import config, { RENDERER_CSP } from './vite.config.electron';

describe('electron vite config', () => {
  it('ignores nested worktree directories in dev watch mode', () => {
    const ignored = config.server?.watch?.ignored;

    expect(ignored).toBeDefined();

    const patterns = Array.isArray(ignored) ? ignored : [ignored];
    expect(patterns).toContain('**/.worktrees/**');
  });
});

describe('renderer Content-Security-Policy', () => {
  it('restricts scripts to the bundle and forbids plugins, framing, and base overrides', () => {
    expect(RENDERER_CSP).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(RENDERER_CSP).toContain("object-src 'none'");
    expect(RENDERER_CSP).toContain("base-uri 'none'");
    expect(RENDERER_CSP).toContain("frame-src 'none'");
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
