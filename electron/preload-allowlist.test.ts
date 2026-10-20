import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { IPC } from './ipc/channels.js';

const require = createRequire(import.meta.url);
const IPC_MANIFEST = require('./ipc/channel-manifest.json') as Record<string, string>;

describe('preload ALLOWED_CHANNELS', () => {
  const preloadSrc = readFileSync(join(__dirname, 'preload.cjs'), 'utf8');
  const extractPreloadChannels = (): string[] => {
    const match = /new Set\(\[([\s\S]*?)\]\)/.exec(preloadSrc);
    if (!match) throw new Error('preload.cjs ALLOWED_CHANNELS literal not found');
    return [...match[1].matchAll(/'([^']+)'/g)].map((channelMatch) => channelMatch[1]);
  };

  it('uses a sandbox-safe inline allowlist', () => {
    expect(preloadSrc).not.toContain("require('./ipc/channel-manifest.json')");
    expect(preloadSrc).toContain('sandboxed preloads cannot require arbitrary local JSON');
  });

  it('keeps the manifest, IPC enum, and preload allowlist as an exact set', () => {
    const channels = Object.values(IPC);
    const IPC_CHANNELS = Object.values(IPC_MANIFEST);
    expect(new Set(IPC_CHANNELS)).toEqual(new Set(channels));
    expect(IPC_CHANNELS).toHaveLength(channels.length);
    expect(new Set(IPC_CHANNELS).size).toBe(IPC_CHANNELS.length);

    const preloadChannels = extractPreloadChannels();
    expect(new Set(preloadChannels)).toEqual(new Set(channels));
    expect(preloadChannels).toHaveLength(channels.length);
    expect(new Set(preloadChannels).size).toBe(preloadChannels.length);
  });

  it('packages the preload artifact', () => {
    const packageJson = require('../package.json') as { build?: { files?: string[] } };
    expect(packageJson.build?.files).toContain('electron/preload.cjs');
    expect(packageJson.build?.files).toContain('electron/browser-preload.cjs');
  });
});
