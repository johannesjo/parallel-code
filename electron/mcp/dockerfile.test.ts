import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

describe('agent Dockerfile', () => {
  it('pins Kimi Code below the workspace-trust-gated 0.33 line', () => {
    const dockerfile = readFileSync(resolve(__dirname, '../../docker/Dockerfile'), 'utf8');

    expect(dockerfile).toContain('# Keep Kimi below 0.33');
    expect(dockerfile).toContain('@moonshot-ai/kimi-code@0.32.0');
  });
});
